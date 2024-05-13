import {
  Keypair,
  Connection,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
} from './constants'
import { Data, readJson } from './utils'
import base58 from 'bs58'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))

const gather = async () => {
  const data: Data[] = readJson()
  if (data.length == 0) {
    console.log("No wallet to gather")
    return
  }
  for (let i = 0; i < data.length; i++) {
    try {
      const wallet = Keypair.fromSecretKey(base58.decode(data[i].privateKey))
      const balance = await solanaConnection.getBalance(wallet.publicKey)
      if (balance == 0) {
        console.log("sol balance is 0, skip this wallet")
        continue
      }
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: mainKp.publicKey,
          lamports: balance - 7 * 10 ** 5
        })
      )
      transaction.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
      transaction.feePayer = wallet.publicKey

      const sig = await sendAndConfirmTransaction(solanaConnection, transaction, [wallet])
      console.log({ sig })
    } catch (error) {
      console.log("Failed to gather sol in a wallet", error)
    }
  }
}

gather()