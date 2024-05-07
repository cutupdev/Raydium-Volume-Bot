import assert from 'assert';

import {
  jsonInfo2PoolKeys,
  Liquidity,
  LiquidityPoolKeys,
  Percent,
  Token,
  TokenAmount,
  ApiPoolInfoV4,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  Market,
  SPL_MINT_LAYOUT,
  SPL_ACCOUNT_LAYOUT,
  TokenAccount,
  TxVersion,
  buildSimpleTransaction,
  LOOKUP_TABLE_CACHE
} from '@raydium-io/raydium-sdk';

import {
  PublicKey,
  Keypair,
  Connection,
  VersionedTransaction
} from '@solana/web3.js';


// import {
//   connection,
//   DEFAULT_TOKEN,
//   makeTxVersion,
//   wallet
// } from '../config';
// import {
//   buildAndSendTx,
//   getWalletTokenAccount,
// } from './util';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getMint, getTokenMetadata } from '@solana/spl-token';
import { RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 } from './original_file/liquidity';
import { logger } from './utils';
import { bundle } from './executor/jito';
import { POOL_ID } from './constants';

type WalletTokenAccounts = Awaited<ReturnType<typeof getWalletTokenAccount>>
type TestTxInputInfo = {
  outputToken: Token
  targetPool: string
  inputTokenAmount: TokenAmount
  slippage: Percent
  walletTokenAccounts: WalletTokenAccounts
  wallet: Keypair
}

async function getWalletTokenAccount(connection: Connection, wallet: PublicKey): Promise<TokenAccount[]> {
  const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
}


async function swapOnlyAmm(connection: Connection, input: TestTxInputInfo) {
  // -------- pre-action: get pool info --------
  const targetPoolInfo = await formatAmmKeysById(connection, input.targetPool)
  assert(targetPoolInfo, 'cannot find the target pool')
  const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys

  // -------- step 1: coumpute amount out --------
  const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
    poolKeys: poolKeys,
    poolInfo: await Liquidity.fetchInfo({ connection, poolKeys }),
    amountIn: input.inputTokenAmount,
    currencyOut: input.outputToken,
    slippage: input.slippage,
  })

  // -------- step 2: create instructions by SDK function --------
  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: input.walletTokenAccounts,
      owner: input.wallet.publicKey,
    },
    amountIn: input.inputTokenAmount,
    amountOut: minAmountOut,
    fixedSide: 'in',
    makeTxVersion: TxVersion.V0,
    computeBudgetConfig: {
      microLamports: 50_000,
      units: 200_000
    }
  })

  logger.info(`Token amount out : ${amountOut.toFixed(4)}`)
  return innerTransactions
}

export async function getBuyTx(solanaConnection: Connection, wallet: Keypair, baseMint: PublicKey, quoteMint: PublicKey, amount: number, targetPool: string) {

  const baseInfo = await getMint(solanaConnection, baseMint)
  if(baseInfo == null){
    logger.error(`Error in getting token decimals`)
    return null
  }
  // const baseTokenAccount = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
  // const baseInfo = await solanaConnection.getTokenAccountBalance(baseTokenAccount)
  // if (baseInfo == null || !baseInfo.value.decimals) {
  //   logger.error(`Base token incorrect`)
  //   return
  // }
  const baseDecimal = baseInfo.decimals

  const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimal)
  const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, 9)

  // const accounts = await solanaConnection.getProgramAccounts(RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, {
  //   commitment: "confirmed",
  //   filters: [
  //     { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
  //     {
  //       memcmp: {
  //         offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
  //         bytes: baseToken.mint.toBase58(),
  //       },
  //     },
  //     {
  //       memcmp: {
  //         offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
  //         bytes: quoteToken.mint.toBase58(),
  //       },
  //     },
  //   ],
  // });

  // if (accounts.length == 0) {
  //   logger.error("No pool exists")
  //   return null
  // }

  // let targetPool
  // if (POOL_ID == "null") {
  //   targetPool = accounts[0].pubkey.toBase58()
  // } else {
  //   if (!accounts.map(acc => acc.pubkey.toBase58()).includes(POOL_ID))
  //     return null
  //   targetPool = POOL_ID
  // }
  // const baseTokenAmount = new TokenAmount(baseToken, amount)
  const quoteTokenAmount = new TokenAmount(quoteToken, Math.round(amount * 10 ** 9))
  const slippage = new Percent(100, 100)
  const walletTokenAccounts = await getWalletTokenAccount(solanaConnection, wallet.publicKey)

  const instructions = await swapOnlyAmm(solanaConnection, {
    outputToken: baseToken,
    targetPool,
    inputTokenAmount: quoteTokenAmount,
    slippage,
    walletTokenAccounts,
    wallet: wallet,
  })

  const willSendTx = (await buildSimpleTransaction({
    connection: solanaConnection,
    makeTxVersion: TxVersion.V0,
    payer: wallet.publicKey,
    innerTransactions: instructions,
    addLookupTableInfo: LOOKUP_TABLE_CACHE
  }))[0]
  if (willSendTx instanceof VersionedTransaction) {
    willSendTx.sign([wallet])
    // await bundle([willSendTx], wallet)
    return willSendTx
  }
  return null
}

export async function formatAmmKeysById(connection: Connection, id: string): Promise<ApiPoolInfoV4> {
  const account = await connection.getAccountInfo(new PublicKey(id))
  if (account === null) throw Error(' get id info error ')
  const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data)

  const marketId = info.marketId
  const marketAccount = await connection.getAccountInfo(marketId)
  if (marketAccount === null) throw Error(' get market info error')
  const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data)

  const lpMint = info.lpMint
  const lpMintAccount = await connection.getAccountInfo(lpMint)
  if (lpMintAccount === null) throw Error(' get lp mint info error')
  const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data)

  return {
    id,
    baseMint: info.baseMint.toString(),
    quoteMint: info.quoteMint.toString(),
    lpMint: info.lpMint.toString(),
    baseDecimals: info.baseDecimal.toNumber(),
    quoteDecimals: info.quoteDecimal.toNumber(),
    lpDecimals: lpMintInfo.decimals,
    version: 4,
    programId: account.owner.toString(),
    authority: Liquidity.getAssociatedAuthority({ programId: account.owner }).publicKey.toString(),
    openOrders: info.openOrders.toString(),
    targetOrders: info.targetOrders.toString(),
    baseVault: info.baseVault.toString(),
    quoteVault: info.quoteVault.toString(),
    withdrawQueue: info.withdrawQueue.toString(),
    lpVault: info.lpVault.toString(),
    marketVersion: 3,
    marketProgramId: info.marketProgramId.toString(),
    marketId: info.marketId.toString(),
    marketAuthority: Market.getAssociatedAuthority({ programId: info.marketProgramId, marketId: info.marketId }).publicKey.toString(),
    marketBaseVault: marketInfo.baseVault.toString(),
    marketQuoteVault: marketInfo.quoteVault.toString(),
    marketBids: marketInfo.bids.toString(),
    marketAsks: marketInfo.asks.toString(),
    marketEventQueue: marketInfo.eventQueue.toString(),
    lookupTableAccount: PublicKey.default.toString()
  }
}



