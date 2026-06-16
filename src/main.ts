import 'reflect-metadata'

import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { json, urlencoded } from 'express'

import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    cors: false,
  })
  const origin = process.env.CORS_ORIGIN
  const allowedOrigins = origin
    ? origin.split(',').map((item) => item.trim()).filter(Boolean)
    : true
  const defaultBodyLimit = process.env.REQUEST_BODY_LIMIT ?? '256kb'
  const rawDataBodyLimit = process.env.RAW_DATA_BODY_LIMIT ?? '2mb'

  app.setGlobalPrefix('api/v1')
  app.use('/api/v1/account/:accountId/raw-data', json({ limit: rawDataBodyLimit }))
  app.use('/api/v1/account/:accountId/raw-course', json({ limit: rawDataBodyLimit }))
  app.use(json({ limit: defaultBodyLimit }))
  app.use(urlencoded({ extended: true, limit: defaultBodyLimit }))
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
