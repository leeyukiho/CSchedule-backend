import { Module } from '@nestjs/common'

import { ProviderDisplayService } from './provider-display.service'
import { ProviderRegistryService } from './provider-registry.service'
import { whhxitProvider } from './adapters/whhxit.provider'
import { whggvcProvider } from './adapters/whggvc.provider'
import { wtbuProvider } from './adapters/wtbu.provider'

@Module({
  providers: [
    {
      provide: ProviderRegistryService,
      useFactory: () => {
        const registry = new ProviderRegistryService()
        registry.register(wtbuProvider)
        registry.register(whhxitProvider)
        registry.register(whggvcProvider)
        return registry
      },
    },
    ProviderDisplayService,
  ],
  exports: [ProviderRegistryService, ProviderDisplayService],
})
export class ProvidersModule {}
