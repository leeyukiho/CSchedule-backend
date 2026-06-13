import { Injectable } from '@nestjs/common'

import { SchoolProvider, SchoolProviderMeta } from './provider.types'

@Injectable()
export class ProviderRegistryService {
  private readonly providers = new Map<string, SchoolProvider>()

  register(provider: SchoolProvider) {
    this.providers.set(provider.id, provider)
  }

  getProvider(providerId: string) {
    const provider = this.providers.get(providerId)

    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    return provider
  }

  listProviders(): SchoolProviderMeta[] {
    return [...this.providers.values()].map((provider) => provider.meta)
  }
}
