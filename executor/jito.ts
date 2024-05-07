import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"
import { logger } from "../utils"
import { SearcherClient, searcherClient } from "jito-ts/dist/sdk/block-engine/searcher"
import { Bundle } from "jito-ts/dist/sdk/block-engine/types"
import { isError } from "jito-ts/dist/sdk/block-engine/utils"
import base58 from "bs58"
import { BLOCKENGINE_URL, JITO_AUTH_KEYPAIR, JITO_FEE, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "../constants"

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})

export async function bundle(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    const txNum = Math.ceil(txs.length / 3)
    for (let i = 0; i < txNum; i++) {
      const upperIndex = (i + 1) * 3
      const downIndex = i * 3
      const newTxs = []
      for (let j = downIndex; j < upperIndex; j++) {
        if (txs[j]) newTxs.push(txs[j])
      }
      let success = await bull_dozer(newTxs, keypair)
      console.log(" bundle ~ success:", success)
      return success
    }
  } catch (error) {
    console.log("Error in bundle", error)
    return false
  }
}

export async function bull_dozer(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    const bundleTransactionLimit = parseInt('4')
    const jitoKey = Keypair.fromSecretKey(base58.decode(JITO_AUTH_KEYPAIR))
    const search = searcherClient(BLOCKENGINE_URL, jitoKey)

    const bundle = await build_bundle(
      search,
      bundleTransactionLimit,
      txs,
      keypair
    )
    console.log(" bull_dozer ~ bundle:", bundle)
    const bundle_result = await onBundleResult(search)
    console.log(" bull_dozer ~ bundle_result:", bundle_result)
    return bundle_result
  } catch (error) {
    console.log("Error in bull dozer ", error)
    return 0
  }
}


async function build_bundle(
  search: SearcherClient,
  bundleTransactionLimit: number,
  txs: VersionedTransaction[],
  keypair: Keypair
) {
  const accounts = await search.getTipAccounts()
  const _tipAccount = accounts[Math.min(Math.floor(Math.random() * accounts.length), 3)]
  // console.log("tip account:", _tipAccount)
  const tipAccount = new PublicKey(_tipAccount)

  const bund = new Bundle([], bundleTransactionLimit)
  const resp = await solanaConnection.getLatestBlockhash()
  bund.addTransactions(...txs)

  let maybeBundle = bund.addTipTx(
    keypair,
    Number(JITO_FEE),
    tipAccount,
    resp.blockhash
  )

  if (isError(maybeBundle)) {
    throw maybeBundle
  }
  try {
    await search.sendBundle(maybeBundle)
    // logger.info("Bundling done")
  } catch (e) {
    console.log(" bundling error:", e)
    logger.info("error in sending bundle\n")
  }
  return maybeBundle
}

export const onBundleResult = (c: SearcherClient): Promise<number> => {
  let first = 0
  let isResolved = false

  return new Promise((resolve) => {
    // Set a timeout to reject the promise if no bundle is accepted within 5 seconds
    setTimeout(() => {
      resolve(first)
      isResolved = true
    }, 5000)

    c.onBundleResult(
      (result: any) => {
        if (isResolved) return first
        // clearTimeout(timeout) // Clear the timeout if a bundle is accepted
        const isAccepted = result.accepted
        const isRejected = result.rejected
        console.log("🚀 ~ returnnewPromise ~ result:", result)
        if (isResolved == false) {

          if (isAccepted) {
            logger.info(`bundle accepted, ID: ${result.bundleId}  | Slot: ${result.accepted!.slot}`)
            first += 1
            isResolved = true
            resolve(first) // Resolve with 'first' when a bundle is accepted
          }
          if (isRejected) {
            // logger.warn("bundle is Rejected\n", result)
            // Do not resolve or reject the promise here
          }
        }
      },
      (e: any) => {
        console.log("on bundle result error", e)
        // Do not reject the promise here
      }
    )
  })
}
