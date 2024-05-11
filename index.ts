import {
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeysV4,
  MAINNET_PROGRAM_ID,
} from '@raydium-io/raydium-sdk'
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  BUY_INTERVAL,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  DISTRIBUTE_WALLET_NUM,
  LOG_LEVEL,
  POOL_ID,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
} from './constants'
import { logger, PoolKeys, sleep } from './utils'
import base58 from 'bs58'
import { distAndBuy } from './utils/distBuy'
import { sell } from './utils/sell'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
let quoteVault: PublicKey | null = null
let vaultAmount: number = 0
let poolKeys: LiquidityPoolKeysV4
logger.level = LOG_LEVEL


const main = async () => {
  const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL
  console.log(`Volume bot is running`)
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  console.log(`Pool token mint: ${baseMint.toBase58()}`)
  console.log(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
  console.log(`Buying interval: ${BUY_INTERVAL}ms`)
  console.log(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
  console.log(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
  console.log(`Distribute SOL to ${distritbutionNum} wallets`)

  let poolId: PublicKey
  if (POOL_ID == "null") {
    poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
    poolId = poolKeys.id
    quoteVault = poolKeys.quoteVault
    console.log(`Successfully fetched pool info`)
  } else {
    poolId = new PublicKey(POOL_ID)
  }

  console.log(`Pool id: ${poolId.toBase58()}`)
  
  // getPoolStatus(poolId)
  distAndBuy(mainKp, poolId, baseMint, distritbutionNum)
  sell(poolId, baseMint)
  // trackWallet()
  // trackRaydium()
}


// const saveStatus = async (connection: Connection, newWallet: Keypair, baseMint: PublicKey) => {
//   const baseTokenAta = await getAssociatedTokenAddress(newWallet.publicKey, baseMint)
//   const solBalance = await connection.getBalance(newWallet.publicKey)
//   let tokenBalance: number = 0
//   try {
//     const ataInfo = await connection.getTokenAccountBalance(baseTokenAta)
//     if (!ataInfo || !ataInfo.value.uiAmount) {
//       console.log(`No token balance in new wallet`)
//     } else {
//       tokenBalance = ataInfo.value.uiAmount
//     }
//   } catch (error) {
//     console.log(`Wallet does not have token bought`)
//   }
//   if (!solBalance || solBalance == 0) {
//     console.log(`Wallet is not charged with SOL`)
//     return
//   }

//   editJson({
//     privateKey: base58.encode(newWallet.secretKey),
//     pubkey: newWallet.publicKey.toBase58(),
//     solBalance: solBalance,
//     solTransferTx,
//     tokenBuyTx: null,
//     tokenSellTx: null
//   })
// }


// interface WalletInfo {
//   kp: Keypair;
//   amount: number;
// }

// const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
//   const wallets: WalletInfo[] = []
//   try {
//     const sendSolTx = new Transaction().add(
//       ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * TX_FEE }),
//       ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 })
//     )
//     for (let i = 0; i < distritbutionNum; i++) {
//       let buyAmount: number
//       if (IS_RANDOM)
//         buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(5))
//       else
//         buyAmount = BUY_AMOUNT
//       if (buyAmount <= 0.002)
//         buyAmount = 0.002

//       const wallet = Keypair.generate()

//       wallets.push({
//         amount: buyAmount,
//         kp: wallet
//       })

//       sendSolTx.add(
//         SystemProgram.transfer({
//           fromPubkey: mainKp.publicKey,
//           toPubkey: wallet.publicKey,
//           lamports: Math.round((buyAmount + 0.005) * LAMPORTS_PER_SOL)
//         })
//       )
//     }
//     sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
//     sendSolTx.feePayer = mainKp.publicKey

//     const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 10 })
//     solTransferTx = `https://solscan.io/tx/${sig}`
//     console.log(`Success in transferring sol: ${solTransferTx}`)
//     return { sig, wallets }

//   } catch (error) {
//     console.log(`Error in transferring SOL`)
//     solTransferTx = ""
//   }
// }

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
        console.log(`Invalid vault info from pool`)
        return
      }
      if (vaultAmount > 0 && newVaultAmount > 0) {
        console.log(`Vault increased amount: ${newVaultAmount - vaultAmount}`)
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

      console.log(`\t url: ${url}`)
      console.log(`\t price: ${priceNative} SOL / ${priceUsd} usd`)
      console.log(`\t Volume status                  =>   m5: $${volume.m5}\t|\th1: $${volume.h1}\t|\th6: $${volume.h6}\t|\t h24: $${volume.h24}`)
      console.log(`\t Recent buy status (buy / sell) =>   m5: ${txns.m5.buys} / ${txns.m5.sells}\t\t|\th1: ${txns.h1.buys} / ${txns.h1.sells}\t|\th6: ${txns.h6.buys} / ${txns.h6.sells}\t|\t h24: ${txns.h24.buys} / ${txns.h24.sells}`)
      console.log(`\t volume price change            =>   m5: ${priceChange.m5}%\t\t|\th1: ${priceChange.h1}%\t|\th6: ${priceChange.h6}%\t|\t h24: ${priceChange.h24}%`)

      await sleep(5000)
    } catch (error) {
      console.log("Error fetching ")
      await sleep(2000)
    }
  }
}


main()

