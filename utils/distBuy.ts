
import {
  NATIVE_MINT,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  ADDITIONAL_FEE,
  BUY_AMOUNT,
  BUY_INTERVAL,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  IS_RANDOM,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TX_FEE
} from '../constants'
import { Data, editJson, logger, saveDataToFile, sleep } from '.'
import base58 from 'bs58'
import { getBuyTx } from './swapOnlyAmm'
import { execute } from '../executor/legacy'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
solanaConnection.getLatestBlockhash().then((block) => console.log({block}))

export const distAndBuy = async (mainKp: Keypair, poolId: PublicKey, baseMint: PublicKey, distritbutionNum: number) => {
  // while (true) {
    try {
      const data = await distributeSol(mainKp, distritbutionNum)
      if (data == null)
        return

      for (let i = 0; i < distritbutionNum; i++) {
        try {
          await sleep(BUY_INTERVAL)
          const { kp: newWallet, buyAmount } = data[i]
          buy(newWallet, baseMint, buyAmount, poolId)
        } catch (error) {
          console.log("Failed to buy token")
        }
      }
    } catch (error) {
      console.log("Failed to distribute")
    }
  // }
}


const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
  const data: Data[] = []
  const wallets = []
  try {
    const sendSolTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * TX_FEE }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 })
    )
    console.log("==> 1")
    for (let i = 0; i < distritbutionNum; i++) {
      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(5))
      else
        buyAmount = BUY_AMOUNT
      if (buyAmount <= 0.002)
        buyAmount = 0.002

      const wallet = Keypair.generate()
      console.log("=> wallet", wallet.publicKey.toBase58())
      wallets.push({ kp: wallet, buyAmount })

      sendSolTx.add(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Math.round((buyAmount + ADDITIONAL_FEE) * LAMPORTS_PER_SOL)
        })
      )
    }
    sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
    sendSolTx.feePayer = mainKp.publicKey
    console.log(await solanaConnection.simulateTransaction(sendSolTx))
    const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 10 })
    const solTransferTx = `https://solscan.io/tx/${sig}`

    wallets.map((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
        solBalance: wallet.buyAmount + ADDITIONAL_FEE,
        solTransferTx: solTransferTx,
        tokenBalance: null,
        tokenBuyTx: null,
        tokenSellTx: null
      })
    })
    saveDataToFile(data)
    console.log(`Success in transferring sol: ${solTransferTx}`)
    return wallets
  } catch (error) {
    console.log(`Failed to transfer SOL`)
    return null
  }
}

const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
  console.log("buy action triggerred")
  let index = 0
  let solBalance: number = 0
  while (index < 10) {
    solBalance = await solanaConnection.getBalance(newWallet.publicKey)
    if (solBalance == 0) {
      index++
      await sleep(500)
    }
  }
  if (solBalance == 0) {
    return
  }
  try {
    const tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58())
    if (tx == null) {
      console.log(`Error getting buy transaction`)
      return null
    }
    const latestBlockhash = await solanaConnection.getLatestBlockhash()
    const txSig = await execute(tx, latestBlockhash)
    const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
    editJson({ tokenBuyTx, pubkey: newWallet.publicKey.toBase58(), solBalance: solBalance - buyAmount })
    return tokenBuyTx
  } catch (error) {
    console.log("Error in buying token")
    return null
  }
}
