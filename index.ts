import {
  LIQUIDITY_STATE_LAYOUT_V4,
  MAINNET_PROGRAM_ID,
} from '@raydium-io/raydium-sdk'
import {
  AccountLayout,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
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
  BUY_AMOUNT,
  BUY_INTERVAL,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  DISTRIBUTE_WALLET_NUM,
  IS_RANDOM,
  LOG_LEVEL,
  POOL_ID,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
  TX_FEE
} from './constants'
import { logger, PoolKeys, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getSellTx } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const baseMint = new PublicKey(TOKEN_MINT)
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
let tokenBuyTx: string = ''
let solTransferTx: string = ''
let quoteVault: PublicKey | null = null
let vaultAmount: number = 0
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
  logger.info(`Distribute SOL to ${distritbutionNum} wallets`)

  let poolId: PublicKey
  if (POOL_ID == "null") {
    const poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
    poolId = poolKeys.id
    quoteVault = poolKeys.quoteVault
    logger.info(`Successfully fetched pool info`)
  } else {
    poolId = new PublicKey(POOL_ID)
  }
  logger.info(`Pool id: ${poolId.toBase58()}`)
  getPoolStatus(poolId)
  // distAndBuy(poolId)
  // trackWallet()
  // trackRaydium()
}

const buy = async (newWallet: Keypair, buyAmount: number, poolId: PublicKey, needToSell: boolean) => {
  const solBalance = await solanaConnection.getBalance(newWallet.publicKey)
  if (!solBalance || solBalance == 0) {
    logger.error("error: sol transferrred, but not confiremd yet")
    return
  }
  try {
    const tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58())
    if (tx == null) {
      logger.error(`Error getting buy transaction`)
      return null
    }
    const latestBlockhash = await solanaConnection.getLatestBlockhash()
    const txSig = await execute(tx, latestBlockhash)
    tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''

    if (needToSell) {
      try {


        const sellTx = await getSellTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount / 2, poolId.toBase58())
        if (sellTx == null) {
          logger.error(`Error getting buy transaction`)
          return null
        }
        const latestBlockhashForSell = await solanaConnection.getLatestBlockhash()
        const txSellSig = await execute(sellTx, latestBlockhashForSell, false)
        const tokenSellTx = txSig ? `https://solscan.io/tx/${txSellSig}` : ''
      } catch (error) {
        console.log("🚀 ~ sell error:", error)
        logger.error("Failed to sell token")
      }
    }
  } catch (error) {
    logger.error("Error in buying token")
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
    solTransferTx
  })
}


interface WalletInfo {
  kp: Keypair;
  amount: number;
}

const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
  const wallets: WalletInfo[] = []
  try {
    const sendSolTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * TX_FEE }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 })
    )
    for (let i = 0; i < distritbutionNum; i++) {
      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(5))
      else
        buyAmount = BUY_AMOUNT
      if (buyAmount <= 0.002)
        buyAmount = 0.002

      const wallet = Keypair.generate()

      wallets.push({
        amount: buyAmount,
        kp: wallet
      })

      sendSolTx.add(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Math.round((buyAmount + 0.005) * LAMPORTS_PER_SOL)
        })
      )
    }
    sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
    sendSolTx.feePayer = mainKp.publicKey

    const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 10 })
    solTransferTx = `https://solscan.io/tx/${sig}`
    logger.info(`Success in transferring sol: ${solTransferTx}`)
    return { sig, wallets }

  } catch (error) {
    logger.error(`Error in transferring SOL`)
    solTransferTx = ""
  }
}

const distAndBuy = async (poolId: PublicKey) => {
  while (true) {
    try {
      const info = await distributeSol(mainKp, distritbutionNum)
      if (info == null) {
        return
      }
      const { wallets, sig } = info
      wallets.map(wallet => saveDataToFile({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
        solBalance: wallet.amount + 0.005,
        solTransferTx: sig,
      }))
      for (let j = 0; j < distritbutionNum; j++) {
        try {
          await sleep(BUY_INTERVAL)
          const { kp: newWallet, amount } = wallets[j]
          const needToSell = j % 2 == 1
          buy(newWallet, amount, poolId, needToSell)
        } catch (error) {
          logger.error("Failed to buy token")
        }
      }

    } catch (error) {
      logger.error("Failed to distribute")
    }
  }
}

const trackWallet = async () => {
  if (quoteVault)
    solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data)
      },
      "confirmed",
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: quoteVault.toBase58(),
          },
        },
      ],
    )
}

const trackRaydium = async () => {
  solanaConnection.onProgramAccountChange(
    MAINNET_PROGRAM_ID.AmmV4,
    async (updatedAccountInfo) => {
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);

      const newVaultAmount = (await solanaConnection.getTokenAccountBalance(poolState.quoteVault)).value.uiAmount
      if (!newVaultAmount) {
        logger.error(`Invalid vault info from pool`)
        return
      }
      if (vaultAmount > 0 && newVaultAmount > 0) {
        logger.warn(`Vault increased amount: ${newVaultAmount - vaultAmount}`)
        vaultAmount = newVaultAmount
      }
    },
    "confirmed",
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: NATIVE_MINT.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
          bytes: baseMint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: base58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );
}

const getPoolStatus = async (poolId: PublicKey) => {
  while (true) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId?.toBase58()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      })
      const data = await res.json()

      const { url, priceNative, priceUsd, txns, volume, priceChange } = data.pair

      logger.warn(`\t url: ${url}`)
      logger.warn(`\t price: ${priceNative} SOL / ${priceUsd} usd`)
      logger.warn(`\t Volume status                  =>   m5: $${volume.m5}\t|\th1: $${volume.h1}\t|\th6: $${volume.h6}\t|\t h24: $${volume.h24}`)
      logger.warn(`\t Recent buy status (buy / sell) =>   m5: ${txns.m5.buys} / ${txns.m5.sells}\t\t|\th1: ${txns.h1.buys} / ${txns.h1.sells}\t|\th6: ${txns.h6.buys} / ${txns.h6.sells}\t|\t h24: ${txns.h24.buys} / ${txns.h24.sells}`)
      logger.warn(`\t volume price change            =>   m5: ${priceChange.m5}%\t\t|\th1: ${priceChange.h1}%\t|\th6: ${priceChange.h6}%\t|\t h24: ${priceChange.h24}%`)

      await sleep(5000)
    } catch (error) {
      logger.error("Error fetching ")
      await sleep(2000)
    }
  }
}

main()



