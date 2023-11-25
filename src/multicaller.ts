import { BytesLike } from '@ethersproject/bytes'
import { BigNumber, Contract, Signer } from 'ethers'
import { CrossChainMessage } from '@eth-optimism/sdk'
import Multicall2 from './contracts/Multicall2.json'
import { splitArray } from './utils'

export type Call = {
  target: string
  callData: BytesLike
}

export type CallWithMeta = Call & {
  blockHeight: number
  txHash: string
  message: CrossChainMessage
  err: Error
}

export class Multicaller {
  public singleCallGas: number

  private readonly contract: Contract
  private readonly targetGas: number
  private readonly gasMultiplier: number

  constructor(
    multicallAddress: string,
    wallet: Signer,
    targetGas: number = 1000000,
    gasMultiplier: number = 1.1
  ) {
    this.contract = new Contract(multicallAddress, Multicall2.abi, wallet)
    this.targetGas = targetGas
    this.gasMultiplier = gasMultiplier
  }

  public isOvertargetGas(size: number): boolean {
    return this.targetGas < this.computeExpectedMulticallGas(size)
  }

  public async multicall(
    calls: CallWithMeta[],
    callback: any
  ): Promise<CallWithMeta[]> {
    const requireSuccess = true
    let estimatedGas: BigNumber
    try {
      estimatedGas = await this.contract.estimateGas.tryAggregate(
        requireSuccess,
        this.convertToCalls(calls)
      )
    } catch (err) {
      // gas is higher than the block gas limit
      if (err.message.includes('gas required exceeds allowance')) {
        // reset single call gas, gas estimation is not accurate
        this.singleCallGas = 0
      }

      // failed even single call, return as list of failed calls
      if (calls.length === 1) {
        calls[0].err = err
        return calls
      }

      // split the array in half and recursively call
      const [firstHalf, secondHalf] = splitArray(calls)
      const results = await this.multicall(firstHalf, callback)
      return [...results, ...(await this.multicall(secondHalf, callback))]
    }

    const overrideOptions = {
      targetGas: ~~(estimatedGas.toNumber() * (this.gasMultiplier || 1.0)),
    }
    const tx = await this.contract.tryAggregate(
      requireSuccess,
      this.convertToCalls(calls),
      overrideOptions
    )
    await tx.wait()

    callback(tx.hash, calls)

    return []
  }

  // Compute expected gas cost of multicall
  // from multiplying the first gas cost of proveMessage by the number of messages
  private computeExpectedMulticallGas(size: number): number {
    return this.singleCallGas * size * this.gasMultiplier
  }

  private convertToCalls(calls: CallWithMeta[]): Call[] {
    return calls.map(({ blockHeight, ...callProps }) => callProps)
  }
}