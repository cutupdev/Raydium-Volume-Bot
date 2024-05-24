import {
  LiquidityPoolKeysV4,
} from '@raydium-io/raydium-sdk'
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js'
import {
  ADDITIONAL_FEE,
  BUY_AMOUNT,
  BUY_INTERVAL_MAX,
  BUY_INTERVAL_MIN,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  DISTRIBUTE_WALLET_NUM,
  DISTRIBUTION_AMOUNT,
  IS_RANDOM,
  LOG_LEVEL,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
} from './constants'
import { Data, editJson, logger, PoolKeys, readJson, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getSellTx } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'
import { bundle } from './executor/jito'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})

export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
let quoteVault: PublicKey | null = null
let vaultAmount: number = 0
let poolId: PublicKey
let poolKeys: LiquidityPoolKeysV4
let sold: number = 0
let bought: number = 0
let totalSolPut: number = 0
let changeAmount = 0
let buyNum = 0
let sellNum = 0
logger.level = LOG_LEVEL


const main = async () => {

  const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL
  console.log(`Volume bot is running`)
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  console.log(`Pool token mint: ${baseMint.toBase58()}`)
  console.log(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
  console.log(`Buying interval max: ${BUY_INTERVAL_MAX}ms`)
  console.log(`Buying interval min: ${BUY_INTERVAL_MIN}ms`)
  console.log(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
  console.log(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
  console.log(`Distribute SOL to ${distritbutionNum} wallets`)

  poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
  poolId = poolKeys.id
  quoteVault = poolKeys.quoteVault
  console.log(`Successfully fetched pool info`)
  console.log(`Pool id: ${poolId.toBase58()}`)

  let data: {
    kp: Keypair;
    buyAmount: number;
  }[] | null = null

  if (solBalance < (BUY_LOWER_AMOUNT + ADDITIONAL_FEE) * distritbutionNum) {
    console.log("Sol balance is not enough for distribution")
  }
  while (true) {
    data = await distributeSol(mainKp, distritbutionNum)
    if (data)
      break
  }

  data.map(async ({ kp }, i) => {
    await sleep((BUY_INTERVAL_MAX + BUY_INTERVAL_MIN) * i / 2)

    while (true) {
      // buy part
      const BUY_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN)

      const solBalance = await solanaConnection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL

      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6))
      else
        buyAmount = BUY_AMOUNT

      if (solBalance < ADDITIONAL_FEE) {
        console.log("Balance is not enough: ", solBalance, "SOL")
        return
      }

      // try buying until success
      while (true) {
        let i = 0
        if (i > 10) {
          console.log("Error in buy transaction")
          return
        }
        const result = await buy(kp, baseMint, buyAmount, poolId)
        if (result) {
          break
        } else {
          i++
          console.log("Buy failed, try again")
          await sleep(5000)
        }
      }

      await sleep(2000)

      // try selling until success
      while (true) {
        let i = 0
        if (i > 10) {
          console.log("Error in sell transaction")
          return
        }
        const result = await sell(poolId, baseMint, kp)
        if (result) {
          break
        } else {
          i++
          console.log("Sell failed, try again")
          await sleep(5000)
        }
      }
      await sleep(5000 + distritbutionNum * BUY_INTERVAL)
    }
  })
}


const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
  const data: Data[] = []
  const wallets = []
  try {
    const sendSolTx: TransactionInstruction[] = []
    for (let i = 0; i < distritbutionNum; i++) {
      let solAmount = DISTRIBUTION_AMOUNT
      if (DISTRIBUTION_AMOUNT < ADDITIONAL_FEE + BUY_UPPER_AMOUNT)
        solAmount = ADDITIONAL_FEE + BUY_UPPER_AMOUNT

      const wallet = Keypair.generate()
      wallets.push({ kp: wallet, buyAmount: solAmount })

      sendSolTx.push(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: solAmount * LAMPORTS_PER_SOL
        })
      )
    }
    const latestBlockhash = await solanaConnection.getLatestBlockhash()
    const messageV0 = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: sendSolTx,
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([mainKp])
    console.log("distribute")
    await bundle([transaction], mainKp)
    console.log("distributed end")
    let index = 0
    while (true) {
      const bal = await solanaConnection.getBalance(wallets[0].kp.publicKey)
      if (index > 30) {
        console.log("Distribution of sol failed")
        return null
      }
      if (bal > 0) {
        break
      } else {
        index++
        await sleep(1500)
      }
    }

    wallets.map((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
        solBalance: wallet.buyAmount + ADDITIONAL_FEE,
        tokenBuyTx: null,
        tokenSellTx: null
      })
    })
    saveDataToFile(data)
    console.log("Success in transferring sol")
    return wallets
  } catch (error) {
    console.log(`Failed to transfer SOL`)
    return null
  }
}


async function makeSwap(tokenAddress: string, rAmount: number | string, type: "buy" | "sell", wallet: Keypair) {
  const solAddress = NATIVE_MINT.toBase58()
  try {
    let response;
    if (type == "buy") {
      const fixedSwapValLamports = Math.floor(Number(rAmount) * 10 ** 9);
      response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=' + solAddress + '&outputMint=' + tokenAddress + '&amount=' + fixedSwapValLamports + '&slippageBps=90');
    } else {
      response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=' + tokenAddress + '&outputMint=' + solAddress + '&amount=' + rAmount + '&slippageBps=90');
    }
    const routes = await response.json();
    const transaction_response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse: routes,
        userPublicKey: wallet.publicKey.toString(),
        wrapUnwrapSOL: true,
        prioritizationFeeLamports: 2000,
        dynamicComputeUnitLimit: true,
      })
    });
    const transactions = await transaction_response.json();
    const { swapTransaction } = transactions;
    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');

    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    // sign the transaction
    transaction.sign([wallet]);
    // Execute the transaction

    const rawTransaction = transaction.serialize()
    const txid = await solanaConnection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });
    await solanaConnection.confirmTransaction(txid);
    console.log(`${type} transaction success: https://solscan.io/tx/${txid}`);

    if (type == "buy") {
      const solBalance = await solanaConnection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL
      editJson({
        tokenBuyTx: `https://solscan.io/tx/${txid}`,
        pubkey: wallet.publicKey.toBase58(),
        solBalance: solBalance,
      })
    } else {
      editJson({
        pubkey: wallet.publicKey.toBase58(),
        tokenSellTx: `https://solscan.io/tx/${txid}`,
      })
    }
    return txid
  } catch (error) {
    console.log("Failed in ", type, " transaction, Trying again")
    // if (type == "buy")
    //   buy(wallet, baseMint, Number(rAmount), poolId)
    // else
    //   sell(poolId, baseMint, wallet)
  }
}




const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
  let solBalance: number = 0
  try {
    solBalance = await solanaConnection.getBalance(newWallet.publicKey)
  } catch (error) {
    console.log("Error getting balance of wallet")
    return null
  }
  if (solBalance == 0) {
    return null
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
    editJson({
      tokenBuyTx,
      pubkey: newWallet.publicKey.toBase58(),
      solBalance: solBalance / 10 ** 9 - buyAmount,
    })
    return tokenBuyTx
  } catch (error) {
    return null
  }
}

const sell = async (poolId: PublicKey, baseMint: PublicKey, wallet: Keypair) => {
  try {
    const data: Data[] = readJson()
    if (data.length == 0) {
      await sleep(1000)
      return null
    }

    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
    if (!tokenBalInfo) {
      console.log("Balance incorrect")
    }
    const tokenBalance = tokenBalInfo.value.amount

    try {
      const sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, tokenBalance, poolId.toBase58())

      if (sellTx == null) {
        console.log(`Error getting buy transaction`)
        return null
      }

      const latestBlockhashForSell = await solanaConnection.getLatestBlockhash()
      const txSellSig = await execute(sellTx, latestBlockhashForSell, false)
      const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : ''
      const solBalance = await solanaConnection.getBalance(wallet.publicKey)
      editJson({
        pubkey: wallet.publicKey.toBase58(),
        tokenSellTx,
        solBalance
      })
      return tokenSellTx
    } catch (error) {
      return null
    }
  } catch (error) {
    return null
  }
}















main()




