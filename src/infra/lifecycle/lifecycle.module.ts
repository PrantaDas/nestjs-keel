import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AppLifecycle } from './app-lifecycle';
import { WorkersShutdown } from './workers-shutdown';

/** Shutdown state and the shutdown steps that are not tied to one infrastructure module. */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [AppLifecycle, WorkersShutdown],
  exports: [AppLifecycle],
})
export class LifecycleModule {}
