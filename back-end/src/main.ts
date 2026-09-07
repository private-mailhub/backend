import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { applyHttpConfig } from './bootstrap/apply-http-config';

// BigInt serialization fix for JSON
BigInt.prototype['toJSON'] = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const isWorker = process.env.WORKER_MODE === 'true';

  if (!isWorker) {
    applyHttpConfig(app);

    const port = process.env.PORT || 8080;
    await app.listen(port);

    console.log(`🚀 Web Server is running on: http://localhost:${port}/api`);
  } else {
    // Worker mode (polling only)
    await app.init();
    console.log(`⚙️  Worker started - SQS polling enabled`);
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
