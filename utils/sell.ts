import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { logger } from "./logger"
import { getSellTx } from "./swapOnlyAmm"
import { execute } from "../executor/legacy"
import { Data, editJson, readJson, sleep } from "./utils"
import base58 from "bs58"
import { SELL_INTERVAL } from "../constants"
import { solanaConnection } from ".."

export const sell = async (poolId: PublicKey, baseMint: PublicKey) => {
  while (true) {
    try {
      const data: Data[] = readJson()
      if (data.length == 0)
        continue
      const dataToSellAll = data.filter((datum: Data) => datum.tokenBalance && datum.tokenBalance > 0)
      if (dataToSellAll.length == 0)
        continue
      const dataToSell = dataToSellAll[0]
      const wallet = Keypair.fromSecretKey(base58.decode(dataToSell.privateKey))
      console.log("tokenBal in file => ", dataToSell.tokenBalance)

      const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
      const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
      if (!tokenBalInfo) {
        console.log("Balance incorrect")
      }
      const tokenBalance = tokenBalInfo.value.amount
      console.log("Real token account balance => ", tokenBalance)

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
          tokenBalance: 0,
          solBalance
        })

      } catch (error) {
        console.log("error in sell action :", error)
      }
    } catch (error) {
      console.log("data or balance error:", error)
      console.log("Failed to sell token")
    }
    await sleep(SELL_INTERVAL)
  }
}


