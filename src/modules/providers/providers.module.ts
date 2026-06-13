import { Module } from '@nestjs/common'

import { ProviderRegistryService } from './provider-registry.service'
import { whhxitProvider } from './adapters/whhxit.provider'
import { wtbuProvider } from './adapters/wtbu.provider'

@Module({
  providers: [
    {
      provide: ProviderRegistryService,
      useFactory: () => {
        const registry = new ProviderRegistryService()
        registry.register(wtbuProvider)
        registry.register(whhxitProvider)
        return registry
      },
    },
  ],
  exports: [ProviderRegistryService],
})
export class ProvidersModule {}
