import 'reflect-metadata'

import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false })
  const origin = process.env.CORS_ORIGIN
  const allowedOrigins = origin
    ? origin.split(',').map((item) => item.trim()).filter(Boolean)
    : true

  app.setGlobalPrefix('api/v1')
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  })
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  )

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
}

void bootstrap()
