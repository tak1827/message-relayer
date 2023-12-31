import { Logger, StandardMetrics } from '@eth-optimism/common-ts'
import { CrossChainMessenger, MessageStatus } from '@eth-optimism/sdk'
import { Multicaller, CallWithMeta } from './multicaller'
import { readFromFile, writeToFile } from './utils'
import { MessageRelayerMetrics, MessageRelayerState } from './service_types'

export default class Prover {
  private state: MessageRelayerState
  private metrics: MessageRelayerMetrics & StandardMetrics
  private logger: Logger
  private stateFilePath: string
  private fromL2TransactionIndex: number
  private l2blockConfirmations: number
  private reorgSafetyDepth: number
  private messenger: CrossChainMessenger
  private multicaller: Multicaller
  private postMessage: (succeeds: CallWithMeta[]) => void
  private initalIteration: boolean = true

  constructor(
    metrics: MessageRelayerMetrics & StandardMetrics,
    logger: Logger,
    stateFilePath: string,
    fromL2TransactionIndex: number | undefined,
    l2blockConfirmations: number,
    reorgSafetyDepth: number,
    messenger: CrossChainMessenger,
    multicaller: Multicaller,
    postMessage: (succeeds: CallWithMeta[]) => void
  ) {
    this.stateFilePath = stateFilePath
    this.metrics = metrics
    this.logger = logger
    this.fromL2TransactionIndex = fromL2TransactionIndex
    this.l2blockConfirmations = l2blockConfirmations
    this.reorgSafetyDepth = reorgSafetyDepth

    this.messenger = messenger
    this.multicaller = multicaller
    this.postMessage = postMessage
  }

  async init() {
    const state = await this.readStateFromFile()
    this.state = state || {
      highestKnownL2: 0,
      highestProvenL2: 0,
      highestFinalizedL2: 0,
    }
    if (this.state.highestProvenL2 < this.fromL2TransactionIndex) {
      this.state.highestProvenL2 = this.fromL2TransactionIndex
      this.state.highestFinalizedL2 = this.fromL2TransactionIndex
    }
  }

  async writeState() {
    await this.writeStateToFile()
  }

  // TODO: incomplete handling
  // failed to handle when reorg started more deep than (proven height + reorgSafetyDepth)
  // to avoide this case, we assume the service is kept live, and the reorg is detected instantly
  public handleL2Reorg(latest: number): void {
    this.updateHighestKnownL2(latest)

    // do nothing if the proven L2 height is lower than the latest - reorgSafetyDepth
    if (this.state.highestProvenL2 <= latest - this.reorgSafetyDepth) {
      return
    }

    // reset proven l2 height as the (latest - reorgSafetyDepth)
    const currentProven = this.state.highestProvenL2
    const newProven = latest - this.reorgSafetyDepth
    this.logger.info(
      `reorg detected. highestProvenL2: ${this.state.highestProvenL2} -> ${
        latest - this.reorgSafetyDepth
      }`
    )
    this.updateHighestProvenL2(newProven)

    // rollback finalized l2 height as same depth as proven l2 height
    const diff = currentProven - newProven
    this.updateHighestFinalizedL2(this.state.highestFinalizedL2 - diff)
  }

  public async handleSingleBlock(
    height: number,
    calldatas: CallWithMeta[] = []
  ): Promise<CallWithMeta[]> {
    const block = await this.messenger.l2Provider.getBlockWithTransactions(
      height
    )
    if (block === null || block.transactions.length === 0) {
      return calldatas
    }

    const target = this.messenger.contracts.l1.OptimismPortal.target

    for (let j = 0; j < block.transactions.length; j++) {
      const txHash = block.transactions[j].hash
      const message = await this.messenger.toCrossChainMessage(txHash)
      const status = await this.messenger.getMessageStatus(message)
      this.logger.debug(
        `[prover] txHash: ${txHash}, status: ${MessageStatus[status]})`
      )

      if (status !== MessageStatus.READY_TO_PROVE) {
        continue
      }

      // Estimate gas cost for proveMessage
      if (this.multicaller?.singleCallGas === 0) {
        const estimatedGas = (
          await this.messenger.estimateGas.proveMessage(txHash)
        ).toNumber()
        this.multicaller.singleCallGas = estimatedGas
      }

      // Populate calldata, the append to the list
      const callData = (
        await this.messenger.populateTransaction.proveMessage(txHash)
      ).data
      calldatas.push({
        target,
        callData,
        blockHeight: block.number,
        txHash,
        message,
        err: null,
      })

      // go next when lower than multicall target gas
      if (!this.multicaller?.isOvertargetGas(calldatas.length)) {
        continue
      }

      // multicall, then handle the result
      // - update the checked L2 height with succeeded calls
      // - post the proven messages to the finalizer
      // - log the failed list with each error message
      this.handleMulticallResult(
        calldatas,
        await this.multicaller?.multicall(calldatas, null)
      )

      // reset calldata list
      calldatas = []
    }

    return calldatas
  }

  public async handleMultipleBlock(): Promise<void> {
    const latest = await this.messenger.l2Provider.getBlockNumber()

    if (latest === this.state.highestKnownL2) {
      return
    } else if (latest < this.state.highestKnownL2) {
      // Reorg detected
      this.handleL2Reorg(latest)
    }

    // update latest known L2 height
    this.updateHighestKnownL2(latest)

    let calldatas: CallWithMeta[] = []

    for (let h = this.startScanHeight(); h <= this.endScanHeight(); h++) {
      calldatas = await this.handleSingleBlock(h, calldatas)
    }

    // flush the left calldata
    if (0 < calldatas.length)
      this.handleMulticallResult(
        calldatas,
        await this.multicaller?.multicall(calldatas, null)
      )
  }

  protected handleMulticallResult(
    calleds: CallWithMeta[],
    faileds: CallWithMeta[]
  ): void {
    const failedIds = new Set(faileds.map((failed) => failed.txHash))
    const succeeds = calleds.filter((call) => !failedIds.has(call.txHash))

    // update the highest checked L2 height
    if (this.updateHighestCheckedL2(succeeds)) {
      this.metrics.numRelayedMessages.inc(succeeds.length)
    }
    // post the proven messages to the finalizer
    this.postMessage(succeeds)

    // record log the failed list with each error message
    for (const fail of faileds) {
      this.logger.warn(
        `[prover] failed to prove: ${fail.txHash}, err: ${fail.err.message}`
      )
    }
  }

  public startScanHeight(): number {
    if (this.initalIteration) {
      // iterate block from the highest finalized at the start of the service
      this.initalIteration = false
      return this.state.highestFinalizedL2
    }
    return this.state.highestProvenL2 + 1
  }

  public endScanHeight(): number {
    return this.state.highestKnownL2 - this.l2blockConfirmations
  }

  protected updateHighestCheckedL2(calldatas: CallWithMeta[]): boolean {
    let highest = calldatas.reduce((maxCall, currentCall) => {
      if (!maxCall || currentCall.blockHeight > maxCall.blockHeight) {
        return currentCall
      }
      return maxCall
    }).blockHeight
    if (0 < highest) highest -= 1 // subtract `1` to assure the all transaction in block is finalized
    if (highest <= this.state.highestProvenL2) return false
    this.updateHighestProvenL2(highest)
    return true
  }

  public highestKnownL2(): number {
    return this.state.highestKnownL2
  }

  public highestProvenL2(): number {
    return this.state.highestProvenL2
  }

  public highestFinalizedL2(): number {
    return this.state.highestFinalizedL2
  }

  public updateHighestKnownL2(latest: number): void {
    this.state.highestKnownL2 = latest
    this.metrics.highestKnownL2.set(this.state.highestKnownL2)
    this.logger.debug(`[prover] highestKnownL2: ${this.state.highestKnownL2}`)
  }

  public updateHighestProvenL2(latest: number): void {
    this.state.highestProvenL2 = latest
    this.metrics.highestProvenL2.set(this.state.highestProvenL2)
    this.logger.debug(`[prover] highestProvenL2: ${this.state.highestProvenL2}`)
  }

  public updateHighestFinalizedL2(latest: number): void {
    this.state.highestFinalizedL2 = latest
    this.metrics.highestFinalizedL2.set(this.state.highestFinalizedL2)
    this.logger.debug(
      `[prover] highestFinalizedL2: ${this.state.highestFinalizedL2}`
    )
  }

  protected async readStateFromFile(): Promise<MessageRelayerState> {
    return await readFromFile(this.stateFilePath)
  }

  public async writeStateToFile(): Promise<void> {
    await writeToFile(this.stateFilePath, this.state)
  }
}
