import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config'
import { getAuthHeaders } from '../../utils/http'
import { logError } from '../../utils/log'
import { getVivusCodeUserAgent } from '../../utils/userAgent'

/**
 * Fetch the user's first Vivus token date and store in config.
 * This is called after successful login to cache when they started using Vivus.
 */
export async function fetchAndStoreVivusCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.vivusCodeFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/vivus_code_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getVivusCodeUserAgent(),
      },
      timeout: 10000,
    })

    const firstTokenDate = response.data?.first_token_date ?? null

    // Validate the date if it's not null
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
        // Don't save invalid dates
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      vivusCodeFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    logError(error)
  }
}
