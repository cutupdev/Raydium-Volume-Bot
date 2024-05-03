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
} from '@solana/web3.js'
import {
  BUY_AMOUNT,
  BUY_INTERVAL,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  IS_RANDOM,
  JITO_FEE,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT
} from './constants'
import { bundle } from './executor/jito'
import { logger, PoolKeys, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const baseMint = new PublicKey(TOKEN_MINT)
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))

const main = async () => {
  const poolKeys = await PoolKeys.fetchPoolKeyInfo(baseMint, NATIVE_MINT)
  console.log("poolKeys:", poolKeys)

  while (true) {
    try {
      const wallet = Keypair.generate()
      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT
      else
        buyAmount = BUY_AMOUNT

      if (buyAmount <= 0) {
        logger.error("Buy Amount Error")
        return
      }

      await buy(mainKp, wallet, baseMint, poolKeys, buyAmount)
      await sleep(BUY_INTERVAL)
      try {
        const baseTokenAssociatedAddress = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
        const tokenBalance = (await solanaConnection.getTokenAccountBalance(baseTokenAssociatedAddress)).value.uiAmount
        const solBalance = (await solanaConnection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL
        saveDataToFile({
          privateKey: base58.encode(wallet.secretKey),
          pubkey: wallet.publicKey.toBase58(),
          solBalance,
          tokenBalance: tokenBalance ? tokenBalance : 0
        })
      } catch (error) {
        logger.error("Error getting balance of wallet after buy")
      }
    } catch (error) {
      logger.error("Error buying token")
    }
  }
}


async function buy(mainKp: Keypair, wallet: Keypair, baseMint: PublicKey, poolKeys: LiquidityPoolKeysV4, buyAmount: number): Promise<void> {

  const quoteTokenAssociatedAddress = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey)
  const baseTokenAssociatedAddress = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
  const quoteToken = new Token(TOKEN_PROGRAM_ID, NATIVE_MINT, 9, "SOL")
  const quoteAmount = new TokenAmount(quoteToken, buyAmount)

  try {
    const latestBlockhash = await solanaConnection.getLatestBlockhash()

    const sendSolIx = SystemProgram.transfer({
      fromPubkey: mainKp.publicKey,
      toPubkey: wallet.publicKey,
      lamports: (buyAmount + JITO_FEE * 2 + 0.01) * LAMPORTS_PER_SOL
    })
    const sendSolMsg = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [sendSolIx]
    }).compileToV0Message()

    const sendSolTx = new VersionedTransaction(sendSolMsg)
    sendSolTx.sign([mainKp])

    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: baseTokenAssociatedAddress,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      poolKeys.version,
    )

    const instructions: TransactionInstruction[] = []
    if (!await solanaConnection.getAccountInfo(quoteTokenAssociatedAddress))
      instructions.push(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          quoteTokenAssociatedAddress,
          wallet.publicKey,
          NATIVE_MINT,
        )
      )
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: quoteTokenAssociatedAddress,
        lamports: buyAmount * 10 ** 9,
      }),
      createSyncNativeInstruction(quoteTokenAssociatedAddress, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        quoteTokenAssociatedAddress,
        wallet.publicKey,
        baseMint,
      ),
      ...innerTransaction.instructions,
    )

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message()
    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([wallet, ...innerTransaction.signers])

    // if (JITO_MODE) {
    await bundle([sendSolTx, transaction], wallet)
    // } else {
    //   await execute(sendSolTx, latestBlockhash)
    //   await execute(transaction, latestBlockhash)
    // }
  } catch (e) {
    // logger.debug(e)
    logger.error(`Failed to buy token, ${baseMint.toBase58()}`)
  }
}
