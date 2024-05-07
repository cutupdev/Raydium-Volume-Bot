import {
  Liquidity,
  LiquidityPoolKeysV4,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  BUY_AMOUNT,
  BUY_INTERVAL,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  IS_RANDOM,
  JITO_FEE,
  LOG_LEVEL,
  POOL_ID,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT
} from './constants'
import { logger, PoolKeys, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx } from './swapOnlyAmm'
import { execute } from './executor/legacy'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const baseMint = new PublicKey(TOKEN_MINT)
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
let tokenBuyTx: string = ''
let solTransferTx: string = ''
logger.level = LOG_LEVEL




const main = async () => {
  const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL
  logger.info(`Volume bot is running`)
  logger.info(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  logger.info(`Pool token mint: ${baseMint.toBase58()}`)
  logger.info(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
  logger.info(`Buying interval: ${BUY_INTERVAL}ms`)
  logger.info(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
  logger.info(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
  let poolId: PublicKey
  if (POOL_ID == "null") {
    const poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
    poolId = poolKeys.id
    logger.info(`Successfully fetched pool info`)
  } else {
    poolId = new PublicKey(POOL_ID)
  }
  logger.info(`Pool id: ${poolId.toBase58()}`)

  distAndBuy(poolId)

  // {
  //   const str = "62X3y83hRCx11HifTb3MiKfafe68zTihfgEsz314Qt8zDeCCT4RQfR52JrUzLYRQjh3uZWpwJeFCe8nzL4DpMLtm"
  //   const keypair = Keypair.fromSecretKey(base58.decode(str))
  //   buy(keypair, 0.001, poolId)
  // }

  // while (true) {
  //   try {
  //     const newWallet = Keypair.generate()
  //     let buyAmount: number
  //     if (IS_RANDOM)
  //       buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(5))
  //     else
  //       buyAmount = BUY_AMOUNT
  //     if (buyAmount <= 0.002)
  //       buyAmount = 0.002

  //     await solTransfer(mainKp, newWallet, buyAmount + 0.005)
  //     logger.info("wait started")
  //     await sleep(BUY_INTERVAL)
  //     logger.info("wait ended")
  //     await buy(newWallet, buyAmount, poolId)
  //     await sleep(10000)
  //     await saveStatus(solanaConnection, newWallet, baseMint)
  //   } catch (e) {
  //     console.log("Error in ", e)
  //   }
  // }
}



const solTransfer = async (mainKp: Keypair, newWallet: Keypair, buyAmount: number) => {
  try {
    const sendSolTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({
        fromPubkey: mainKp.publicKey,
        toPubkey: newWallet.publicKey,
        lamports: Math.round(buyAmount * LAMPORTS_PER_SOL)
      })
    )

    sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
    sendSolTx.feePayer = mainKp.publicKey

    const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 10 })
    solTransferTx = `https://solscan.io/tx/${sig}`
    logger.info(`Success in transferring sol: ${solTransferTx}`)
    console.log("secretkey \n", base58.encode(newWallet.secretKey))
    return sig
  } catch (error) {
    console.log("error in sol transfer => ", error)
    logger.error(`Error in transferring SOL`)
    solTransferTx = ""
  }
}

const buy = async (newWallet: Keypair, buyAmount: number, poolId: PublicKey) => {
  console.log("🚀 ~ buy ~ buyAmount:", buyAmount)
  const solBalance = await solanaConnection.getBalance(newWallet.publicKey)
  if (!solBalance || solBalance == 0) {
    console.log("error: sol transferrred, but not confiremd yet")
    return
  }
  console.log("🚀 ~ buy ~ solBalance:", solBalance)
  try {
    const tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58())
    if (tx == null) {
      logger.error(`Error getting buy transaction`)
      return null
    }
    const latestBlockhash = await solanaConnection.getLatestBlockhash()
    const txSig = await execute(tx, latestBlockhash)
    tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
    
  } catch (error) {
    console.log("🚀 ~ buy ~ error:", error)
    console.log("Error in buying X9X-")
    tokenBuyTx = ""
  }
}

const saveStatus = async (connection: Connection, newWallet: Keypair, baseMint: PublicKey) => {
  const baseTokenAta = await getAssociatedTokenAddress(newWallet.publicKey, baseMint)
  const solBalance = await connection.getBalance(newWallet.publicKey)
  let tokenBalance: number = 0
  try {
    const ataInfo = await connection.getTokenAccountBalance(baseTokenAta)
    if (!ataInfo || !ataInfo.value.uiAmount) {
      logger.warn(`No token balance in new wallet`)
    } else {
      tokenBalance = ataInfo.value.uiAmount
    }
  } catch (error) {
    logger.error(`Wallet does not have token bought`)
  }
  if (!solBalance || solBalance == 0) {
    logger.error(`Wallet is not charged with SOL`)
    return
  }

  saveDataToFile({
    privateKey: base58.encode(newWallet.secretKey),
    pubkey: newWallet.publicKey.toBase58(),
    solBalance: solBalance,
    tokenBalance: tokenBalance,
    tokenBuyTx,
    solTransferTx
  })
}

// main()


















interface WalletInfo {
  kp: Keypair;
  amount: number;
}

const distributeSol = async (mainKp: Keypair, txsPerNum: number) => {
  const wallets: WalletInfo[] = []
  try {
    const sendSolTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 800_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })
    )
    for (let i = 0; i < txsPerNum; i++) {
      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(5))
      else
        buyAmount = BUY_AMOUNT
      if (buyAmount <= 0.001)
        buyAmount = 0.001

      const wallet = Keypair.generate()

      wallets.push({
        amount: buyAmount,
        kp: wallet
      })

      sendSolTx.add(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Math.round((buyAmount + 0.002) * LAMPORTS_PER_SOL)
        })
      )
    }
    sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
    sendSolTx.feePayer = mainKp.publicKey

    console.log(await solanaConnection.simulateTransaction(sendSolTx))

    const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 10 })
    solTransferTx = `https://solscan.io/tx/${sig}`
    logger.info(`Success in transferring sol: ${solTransferTx}`)
    return {sig, wallets}

  } catch (error) {
    console.log("error in sol transfer => ", error)
    logger.error(`Error in transferring SOL`)
    solTransferTx = ""
  }
}

const txsPerNum = 10

const distAndBuy = async (poolId: PublicKey) => {
  
  const info = await distributeSol(mainKp, txsPerNum)
  if(info == null){
    return 
  } 
  const {wallets, sig} = info
  for (let j = 0; j < txsPerNum; j++) {
    await sleep(BUY_INTERVAL)
    const {kp: newWallet, amount} = wallets[j]
    buy(newWallet, amount, poolId)
    console.log("here is buy action")
  }
}


main()