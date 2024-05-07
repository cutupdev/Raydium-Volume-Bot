import { logger, retrieveEnvVariable } from "../utils"

export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger)
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger)
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger)

export const IS_RANDOM = retrieveEnvVariable('IS_RANDOM', logger) === 'true'
export const BUY_AMOUNT = Number(retrieveEnvVariable('BUY_AMOUNT', logger))
export const BUY_UPPER_AMOUNT = Number(retrieveEnvVariable('BUY_UPPER_AMOUNT', logger))
export const BUY_LOWER_AMOUNT = Number(retrieveEnvVariable('BUY_LOWER_AMOUNT', logger))
export const BUY_INTERVAL = Number(retrieveEnvVariable('BUY_INTERVAL', logger))
// export const BUY_DURATION = Number(retrieveEnvVariable('BUY_DURATION', logger))

// export const PRICE_MODE = retrieveEnvVariable('PRICE_MODE', logger) === 'true'
// export const START_BUYING_WHEN_PRICE_DROPS = Number(retrieveEnvVariable('START_BUYING_WHEN_PRICE_DROPS', logger))
// export const STOP_WHEN_PRICE_RAISES = Number(retrieveEnvVariable('STOP_WHEN_PRICE_RAISES', logger))
// export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger))

export const TOKEN_MINT = retrieveEnvVariable('TOKEN_MINT', logger)
export const POOL_ID = retrieveEnvVariable('POOL_ID', logger)

export const BLOCKENGINE_URL = retrieveEnvVariable('BLOCKENGINE_URL', logger)
// export const JITO_MODE = retrieveEnvVariable('JITO_MODE', logger) === 'true'
export const JITO_FEE = Number(retrieveEnvVariable('JITO_FEE', logger))
export const JITO_AUTH_KEYPAIR = retrieveEnvVariable('JITO_KEY', logger)

export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger)

