import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Percent,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk'
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity'
import { logger } from './utils'
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market'
import { MintLayout } from './types'
import bs58 from 'bs58'
import * as fs from 'fs'
import * as path from 'path'
import readline from 'readline'
import {
  AUTO_SELL,
  AUTO_SELL_DELAY,
  CHECK_IF_MINT_IS_RENOUNCED,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  MAX_SELL_RETRIES,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  MIN_POOL_SIZE,
  MAX_POOL_SIZE,
  ONE_TOKEN_AT_A_TIME,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  TAKE_PROFIT1,
  TAKE_PROFIT2,
  STOP_LOSS,
  SELL_SLIPPAGE,
  CHECK_IF_MINT_IS_MUTABLE,
  CHECK_IF_MINT_IS_BURNED,
  JITO_MODE,
  JITO_ALL,
  SELL_AT_TP1,
} from './constants'
import { clearMonitor, monitor } from './utils/monitor'
import { BN } from 'bn.js'
import { checkBurn, checkMutable } from './tokenFilter'
import { bundle } from './executor/jito'
import { execute } from './executor/legacy'
import { jitoWithAxios } from './executor/jitoWithAxios'
import { PoolKeys } from './utils/getPoolKeys'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})

export interface MinimalTokenAccountData {
  mint: PublicKey
  address: PublicKey
  poolKeys?: LiquidityPoolKeys
  market?: MinimalMarketLayoutV3
}

const existingLiquidityPools: Set<string> = new Set<string>()
const existingOpenBookMarkets: Set<string> = new Set<string>()
const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>()

let wallet: Keypair
let quoteToken: Token
let quoteTokenAssociatedAddress: PublicKey
let quoteAmount: TokenAmount
let quoteMinPoolSizeAmount: TokenAmount
let quoteMaxPoolSizeAmount: TokenAmount
let processingToken: Boolean = false
let poolId: PublicKey
let tokenAccountInCommon: MinimalTokenAccountData | undefined
let accountDataInCommon: LiquidityStateV4 | undefined
let idDealt: string = NATIVE_MINT.toBase58()
let snipeList: string[] = []

async function init(): Promise<void> {
  logger.level = LOG_LEVEL

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
  const solBalance = await solanaConnection.getBalance(wallet.publicKey)
  logger.info(`Wallet Address: ${wallet.publicKey}`)
  logger.info(`SOL balance: ${(solBalance / 10 ** 9).toFixed(3)}SOL`)

  // get quote mint and amount
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false)
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false)
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false)
      break
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      )
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false)
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false)
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false)
      break
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`)
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`)
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`)
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed(2)} ${quoteToken.symbol}`,
  )
  logger.info(
    `Max pool size: ${quoteMaxPoolSizeAmount.isZero() ? 'false' : quoteMaxPoolSizeAmount.toFixed(2)} ${quoteToken.symbol}`,
  )
  logger.info(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`)
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`)
  logger.info(`Auto sell: ${AUTO_SELL}`)
  logger.info(`Sell delay: ${AUTO_SELL_DELAY === 0 ? 'false' : AUTO_SELL_DELAY}`)

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL)

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    })
  }

  quoteTokenAssociatedAddress = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey)

  const wsolBalance = await solanaConnection.getBalance(quoteTokenAssociatedAddress)

  logger.info(`WSOL Balance: ${wsolBalance}`)
  if (!(!wsolBalance || wsolBalance == 0))
    // await unwrapSol(quoteTokenAssociatedAddress)
    // load tokens to snipe
    loadSnipeList()
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey)
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  }
  existingTokenAccounts.set(mint.toString(), tokenAccount)
  return tokenAccount
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (idDealt == id.toString()) return
  idDealt = id.toBase58()
  logger.info(`Detected a new pool: https://dexscreener.com/solana/${id.toString()}`)
  try {
    const quoteBalance = (await solanaConnection.getBalance(poolState.quoteVault, "processed")) / 10 ** 9

    if (!shouldBuy(poolState.baseMint.toString())) {
      return
    }
    if (!quoteMinPoolSizeAmount.isZero()) {
      logger.info(`Processing pool: ${id.toString()} with ${quoteBalance.toFixed(2)} ${quoteToken.symbol} in liquidity`)

      // if (poolSize.lt(quoteMinPoolSizeAmount)) {
      if (parseFloat(MIN_POOL_SIZE) > quoteBalance) {
        logger.warn(`Skipping pool, smaller than ${MIN_POOL_SIZE} ${quoteToken.symbol}`)
        logger.info(`-------------------------------------- \n`)
        return
      }
    }

    if (!quoteMaxPoolSizeAmount.isZero()) {
      const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true)

      // if (poolSize.gt(quoteMaxPoolSizeAmount)) {
      if (parseFloat(MAX_POOL_SIZE) < quoteBalance) {
        logger.warn(`Skipping pool, larger than ${MIN_POOL_SIZE} ${quoteToken.symbol}`)
        logger.warn(
          `Skipping pool, bigger than ${quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
          `Swap quote in amount: ${poolSize.toFixed()}`,
        )
        logger.info(`-------------------------------------- \n`)
        return
      }
    }
  } catch (error) {
    logger.warn(`Error in getting new pool balance, ${error}`)
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint)

    if (mintOption !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can mint tokens!')
      return
    }
  }

  if (CHECK_IF_MINT_IS_MUTABLE) {
    const mutable = await checkMutable(solanaConnection, poolState.baseMint)
    if (mutable == true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, token is mutable!')
      return
    }
  }

  if (CHECK_IF_MINT_IS_BURNED) {
    const burned = await checkBurn(solanaConnection, poolState.lpMint, COMMITMENT_LEVEL)
    if (burned !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, token is not burned!')
      return
    }
  }
  processingToken = true
  await buy(id, poolState)
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {}
    if (!data) {
      return
    }
    const deserialize = MintLayout.decode(data)
    return deserialize.mintAuthorityOption === 0
  } catch (e) {
    logger.debug(e)
    logger.error({ mint: vault }, `Failed to check if mint is renounced`)
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data)

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return
    }

    saveTokenAccount(accountData.baseMint, accountData)
  } catch (e) {
    logger.debug(e)
    logger.error({ mint: accountData?.baseMint }, `Failed to process market`)
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {

  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString())
    tokenAccountInCommon = tokenAccount
    accountDataInCommon = accountData
    if (!tokenAccount) {
      // it's possible that we didn't have time to fetch open book data
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, COMMITMENT_LEVEL)
      tokenAccount = saveTokenAccount(accountData.baseMint, market)
    }

    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!)
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    )

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: COMMITMENT_LEVEL,
    })

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
        lamports: Math.ceil(parseFloat(QUOTE_AMOUNT) * 10 ** 9),
      }),
      createSyncNativeInstruction(quoteTokenAssociatedAddress, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        tokenAccount.address,
        wallet.publicKey,
        accountData.baseMint,
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

    if (JITO_MODE) {
      if (JITO_ALL) {
        await jitoWithAxios(transaction, wallet, latestBlockhash)
      } else {
        const result = await bundle([transaction], wallet)
      }
    } else {
      await execute(transaction, latestBlockhash)
    }
  } catch (e) {
    logger.debug(e)
    logger.error(`Failed to buy token, ${accountData.baseMint}`)
  }
}

export async function sell(mint: PublicKey, amount: BigNumberish, isTp1Sell: boolean = false): Promise<void> {

  try {
    const tokenAccount = existingTokenAccounts.get(mint.toString())

    if (!tokenAccount) {
      logger.error("Sell token account not exist")
      return
    }

    if (!tokenAccount.poolKeys) {
      logger.warn({ mint }, 'No pool keys found')
      return
    }

    if (amount == 0) {
      logger.info(
        {
          mint: tokenAccount.mint,
        },
        `Checking: Sold already`,
      )
      return
    }
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys!,
        userKeys: {
          tokenAccountOut: quoteTokenAssociatedAddress,
          tokenAccountIn: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: amount,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys!.version,
    )

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: COMMITMENT_LEVEL,
    })

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...innerTransaction.instructions,
        createCloseAccountInstruction(quoteTokenAssociatedAddress, wallet.publicKey, wallet.publicKey),
      ],
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([wallet, ...innerTransaction.signers])

    if (JITO_MODE) {
      if (JITO_ALL) {
        await jitoWithAxios(transaction, wallet, latestBlockhash)
      } else {
        await bundle([transaction], wallet)
      }
    } else {
      await execute(transaction, latestBlockhash)
    }
  } catch (e: any) {
    await sleep(1000)
    logger.debug(e)
  }
  if (!isTp1Sell)
    await sell(mint, amount, true)
  processingToken = false
}

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return
  }
  const count = snipeList.length
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8')
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a)

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`)
  }
}

function shouldBuy(key: string): boolean {
  logger.info(`-------------------------------------- `)
  logger.info(`Processing token: ${processingToken}`)
  return USE_SNIPE_LIST ? snipeList.includes(key) : ONE_TOKEN_AT_A_TIME ? !processingToken : true
}

const runListener = async () => {
  await init()
  const runTimestamp = Math.floor(new Date().getTime() / 1000)
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString()
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data)
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString())
      const existing = existingLiquidityPools.has(key)

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key)
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState)
        poolId = updatedAccountInfo.accountId
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  )

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString()
      const existing = existingOpenBookMarkets.has(key)
      if (!existing) {
        existingOpenBookMarkets.add(key)
        const _ = processOpenBookMarket(updatedAccountInfo)
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  )

  const walletSubscriptionId = solanaConnection.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    async (updatedAccountInfo) => {
      await walletChange(updatedAccountInfo)
    },
    COMMITMENT_LEVEL,
    [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 32,
          bytes: wallet.publicKey.toBase58(),
        },
      },
    ],
  )

  logger.info(`Listening for wallet changes: ${walletSubscriptionId}`)
  // }

  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`)
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`)

  logger.info('----------------------------------------')
  logger.info('Bot is running! Press CTRL + C to stop it.')
  logger.info('----------------------------------------')

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL)
  }
}



const unwrapSol = async (wSolAccount: PublicKey) => {
  try {
    const wsolAccountInfo = await solanaConnection.getAccountInfo(wSolAccount)
    if (wsolAccountInfo) {
      const wsolBalanace = await solanaConnection.getBalance(wSolAccount)
      logger.warn(`Trying to unwrap ${wsolBalanace / 10 ** 9}wsol to sol`)
      const instructions = []

      instructions.push(
        createCloseAccountInstruction(
          wSolAccount,
          wallet.publicKey,
          wallet.publicKey
        )
      )
      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: COMMITMENT_LEVEL,
      })

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [...instructions],
      }).compileToV0Message()

      const transaction = new VersionedTransaction(messageV0)
      transaction.sign([wallet])
      if (JITO_MODE) {
        if (JITO_ALL) {
          const result = await jitoWithAxios(transaction, wallet, latestBlockhash)
        } else {
          const result = await bundle([transaction], wallet)
        }
      } else {
        await execute(transaction, latestBlockhash)
      }
      await sleep(5000)
      const wBal = await solanaConnection.getBalance(wSolAccount)
      if (wBal > 0) {
        logger.warn("Unwrapping WSOL failed")
      } else {
        logger.info("Successfully unwrapped WSOL to SOL")
      }
    }
  } catch (error) {
    logger.warn("Error unwrapping WSOL")
  }
}


const inputAction = async (accountId: PublicKey, mint: PublicKey, amount: BigNumberish) => {
  logger.warn("\n==========================================================\n")
  rl.question('If you want to sell, plz input "sell" and press enter: \n\n', async (data) => {
    const input = data.toString().trim() // Convert input to string and remove whitespace
    let tokenBalance: string
    if (input === 'sell') {
      do {
        try {
          tokenBalance = (await solanaConnection.getTokenAccountBalance(accountId, 'processed')).value.amount
          break
        } catch (error) {
          logger.warn("Still not able to get token account balance", error)
          await sleep(500)
        }
      } while (true);
      const _ = await sell(mint, tokenBalance)
    } else {
      logger.warn('Received input invalid :\t', input)
      inputAction(accountId, mint, amount)
    }
  })
}

const priceMatch = async (amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) => {
  try {
    if (PRICE_CHECK_DURATION === 0 || PRICE_CHECK_INTERVAL === 0) {
      return
    }
    let priceMatchAtOne = false
    const timesToCheck = PRICE_CHECK_DURATION / PRICE_CHECK_INTERVAL
    const temp = amountIn.denominator.toString()
    const tokenAmount = new BN(temp.substring(0, temp.length - 2))
    const sellAt1 = tokenAmount.mul(new BN(SELL_AT_TP1))
    const slippage = new Percent(SELL_SLIPPAGE, 100)

    const tp1 = Number((Number(QUOTE_AMOUNT) * (100 + TAKE_PROFIT1) / 100).toFixed(4))
    const tp2 = Number((Number(QUOTE_AMOUNT) * (100 + TAKE_PROFIT2) / 100).toFixed(4))
    const sl = Number((Number(QUOTE_AMOUNT) * (100 - STOP_LOSS) / 100).toFixed(4))
    let timesChecked = 0
    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: solanaConnection,
          poolKeys,
        })

        const { amountOut } = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn,
          currencyOut: quoteToken,
          slippage,
        })
        const pnl = Number(amountOut.toFixed(6)) / Number(QUOTE_AMOUNT) * 100
        logger.info(
          `Take profit1: ${tp1} SOL | Take profit2: ${tp2} SOL  | Stop loss: ${sl} SOL | Buy amount: ${QUOTE_AMOUNT} SOL | Current: ${amountOut.toFixed(4)} SOL | PNL: ${pnl}%`,
        )
        const amountOutNum = Number(amountOut.toFixed(7))
        if (amountOutNum < sl) {
          logger.info({ stopLoss: "Token is on stop loss point, will sell with loss" })
          break
        }

        if (amountOutNum > tp1) {
          if (!priceMatchAtOne) {
            logger.info({ takeProfit: "Token is on first level profit, will sell some and wait for second level higher profit" })
            priceMatchAtOne = true
            // break
          }
          
          if (SELL_AT_TP1 > 0)
            sell(poolKeys.baseMint, sellAt1, true)
        }

        if (amountOutNum < tp1 && priceMatchAtOne) {
          logger.info({ stopLoss: "Token is on first level profit again, will sell with first level" })
          break
        }

        if (amountOutNum > tp2) {
          logger.info({ stopLoss: "Token is on second level profit, will sell with second level profit" })
          break
        }
      } catch (e) {
        logger.warn(`Price calculation is unknown, because token account is not confirmed`)
      } finally {
        timesChecked++
      }
      await sleep(PRICE_CHECK_INTERVAL)
    } while (timesChecked < timesToCheck)
  } catch (error) {
    logger.warn("Error when setting profit amounts", error)
  }
}

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

runListener()


let bought: string = NATIVE_MINT.toBase58()

const walletChange = async (updatedAccountInfo: KeyedAccountInfo) => {
  const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data)
  if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
    return
  }

  if (tokenAccountInCommon && accountDataInCommon) {
    if (bought != accountDataInCommon.baseMint.toBase58()) {
      logger.info(`\n--------------- bought token successfully ---------------------- \n`)
      logger.info(`https://dexscreener.com/solana/${accountDataInCommon.baseMint.toBase58()}`)
      logger.info(`PHOTON: https://photon-sol.tinyastro.io/en/lp/${tokenAccountInCommon.poolKeys!.id.toString()}`)
      logger.info(`DEXSCREENER: https://dexscreener.com/solana/${tokenAccountInCommon.poolKeys!.id.toString()}`)
      logger.info(`JUPITER: https://jup.ag/swap/${accountDataInCommon.baseMint.toBase58()}-SOL`)
      logger.info(`BIRDEYE: https://birdeye.so/token/${accountDataInCommon.baseMint.toBase58()}?chain=solana`)
      bought = accountDataInCommon.baseMint.toBase58()

      const tokenIn = new Token(TOKEN_PROGRAM_ID, tokenAccountInCommon.poolKeys!.baseMint, tokenAccountInCommon.poolKeys!.baseDecimals)
      const tokenAmountIn = new TokenAmount(tokenIn, accountData.amount, true)
      inputAction(updatedAccountInfo.accountId, accountData.mint, accountData.amount)

      if (AUTO_SELL_DELAY > 0) {
        logger.info("Delay timer activated")
        await sleep(AUTO_SELL_DELAY)
        logger.info("Delay timer ended")
      }
      await priceMatch(tokenAmountIn, tokenAccountInCommon.poolKeys!)

      const tokenAccount = await getAssociatedTokenAddress(accountData.mint, wallet.publicKey)
      let tokenBalance
      do {
        try {
          tokenBalance = (await solanaConnection.getTokenAccountBalance(tokenAccount, 'processed')).value.amount
          break
        } catch (error) {
          logger.warn("Still not able to get token account balance", error)
          await sleep(500)
        }
      } while (true);
      const _ = await sell(accountData.mint, tokenBalance)
    }
  }
}