import axios from 'axios';
import { Web3Wrapper, TxData, SupportedProvider } from "@0x/web3-wrapper";
import { GetSwapQuoteResponse, ZeroExSwapAPIParams, ERC20TokenContract, EIGHT_GWEI_IN_WEI } from "./misc";
import { getContractAddressesForChainOrThrow, ChainId } from "@0x/contract-addresses";
import { BigNumber } from '@0x/utils';
import { Web3ProviderEngine } from '@0x/subproviders';

const zeroExDeployedAddresses = getContractAddressesForChainOrThrow(ChainId.Kovan);


async function introToERC20TokenContract(web3Provider: Web3ProviderEngine): Promise<void> {
    // A quick example of ERC20TokenContract

    // Initializing a new instance of ERC20TokenContract
    const tokenAddress = '0x48178164eB4769BB919414Adc980b659a634703E' // Address of fake DAI token
    const tokenContract: ERC20TokenContract = new ERC20TokenContract(tokenAddress, web3Provider);

    // Reading a value on the blockchain does NOT require a transaction.
    const name = await tokenContract.name().callAsync()
    const decimals = await tokenContract.decimals().callAsync()
    const balance = await tokenContract.balanceOf('0xSomeAddress').callAsync()

    console.log(name) // DAI
    console.log(decimals) // 18
    console.log(balance) // 100000000000000000000

    // Writing a value on the blockchain 
    await tokenContract.transfer(
        '0xSomeOtherAddress',
        new BigNumber(100000000000000000000),
    ).awaitTransactionSuccessAsync({
        from: '0xMyAddress',
    });
}

/**
 * Converts a humanly-readable number (that may contain decimals, example: 133.232) into a big integer.
 * Why do we need this: Ethereum can only only store integer values, so, in order to generate a number
 * that can be diplayed to users (in a UI), you need to store that number as a big integer + the number of
 * decimal places.
 * 
 * Example:
 * (USDC has 6 decimals, DAI has 18 decimals)
 * 
 * - convertValueFromHumanToEthereum(usdcToken, 5) returns 5000000
 * - convertValueFromHumanToEthereum(daiToken, 20.5) returns 20500000000000000000
 * 
 * @param tokenWrapper an instance of the ERC20 token wrapper
 * @param unitAmount a number representing the human-readable number
 * @returns a big integer that can be used to interact with Ethereum
 */
async function convertValueFromHumanToEthereum(tokenWrapper: ERC20TokenContract, unitAmount: number): Promise<BigNumber> {
    const decimals = await tokenWrapper.decimals().callAsync();
    return Web3Wrapper.toBaseUnitAmount(unitAmount, decimals.toNumber());
}

/**
 * Performs a trade by requesting a quote from the 0x API, and filling that quote on the blockchain
 * @param buyToken the token address to buy
 * @param sellToken the token address to sell
 * @param amountToSellUnitAmount the token amount to sell
 * @param fromAddress the address that will perform the transaction
 * @param client the Web3Wrapper client
 */
export async function performSwapAsync(
    buyTokenWrapper: ERC20TokenContract,
    sellTokenWrapper: ERC20TokenContract,
    amountToSellUnitAmount: number,
    fromAddress: string,
    provider: SupportedProvider,
): Promise<void> {

    // Check #1) Does the user have enough balance?
    // Convert the unit amount into base unit amount (bigint). For this to happen you need the number of decimals the token.
    // Fetch decimals using the getDecimalsForToken(), and use Web3Wrapper.toBaseUnitAmount() to perform the conversion
    const amountToSellInBaseUnits = await convertValueFromHumanToEthereum(sellTokenWrapper, amountToSellUnitAmount);
    const sellTokenBalanceInBaseUnit = await sellTokenWrapper.balanceOf(fromAddress).callAsync();
    if (amountToSellInBaseUnits > sellTokenBalanceInBaseUnit) {
        throw new Error(`Insufficient funds.`)
    }

    // Check #2) Does the 0x ERC20 Proxy have permission to withdraw funds from the exchange?
    const currentAllowanceInBaseUnitAmount = await sellTokenWrapper.allowance(fromAddress, zeroExDeployedAddresses.erc20Proxy).callAsync();
    if (currentAllowanceInBaseUnitAmount < amountToSellInBaseUnits) {

        // In order to allow the 0x smart contracts to trade with your funds, you need to set an allowance for zeroExDeployedAddresses.erc20Proxy.
        // This can be done using the `approve` function.
        const allowance = await convertValueFromHumanToEthereum(sellTokenWrapper, 300);
        await sellTokenWrapper.approve(zeroExDeployedAddresses.erc20Proxy, allowance).awaitTransactionSuccessAsync({from: fromAddress})
    }
        
    // Step #2) Make a request to the 0x API swap endpoint: https://0x.org/docs/guides/swap-tokens-with-0x-api#swap-eth-for-1-dai
    // You can use the line below as guidance. In the example, the variable TxData contains the deserialized JSON response from the API.
    const url = `https://kovan.api.0x.org/swap/v0/quote`;
    const params: ZeroExSwapAPIParams = {
        buyToken: buyTokenWrapper.address,
        sellToken: sellTokenWrapper.address,
        sellAmount: amountToSellInBaseUnits.toString(),
        takerAddress: fromAddress,
        slippagePercentage: '0.01',
        gasPrice: EIGHT_GWEI_IN_WEI.toString(),
    }
    const httpResponse = await axios.get<GetSwapQuoteResponse>(url, { params })
    const txData: TxData = {
        from: httpResponse.data.from,
        to: httpResponse.data.to,
        data: httpResponse.data.data,
        gas: httpResponse.data.gas,
        gasPrice: httpResponse.data.gasPrice,
        value: httpResponse.data.value,
    };
    console.log(`Ethereum transaction generated by the 0x API: 👇`);
    console.log(txData);
    
    console.log(`Orders used to perform the swap 👇`);
    console.log(httpResponse.data.orders);

    // Step #3) You can `client.sendTransactionAsync()` to send a Ethereum transaction.
    const client = new Web3Wrapper(provider);
    await client.sendTransactionAsync(txData);
}