/**
 * @file wasm-fuel-meter.ts
 * Instruction and compute metering to prevent infinite loops and runaway compute in WASM plugins.
 */

import { WasmFuelExhaustedError, type WasmFuelConfig } from './wasm-types';

export class WasmFuelMeter {
  private readonly initialFuel: bigint;
  private fuelRemaining: bigint;
  private fuelConsumed: bigint;
  private readonly pluginId?: string | undefined;

  constructor(config: WasmFuelConfig, pluginId?: string) {
    this.initialFuel = config.initialFuel > 0n ? config.initialFuel : 1_000_000n;
    this.fuelRemaining = this.initialFuel;
    this.fuelConsumed = 0n;
    if (pluginId) {
      this.pluginId = pluginId;
    }
  }

  public getInitialFuel(): bigint {
    return this.initialFuel;
  }

  public getRemainingFuel(): bigint {
    return this.fuelRemaining;
  }

  public getConsumedFuel(): bigint {
    return this.fuelConsumed;
  }

  public consume(units: bigint | number): void {
    const amount = typeof units === 'bigint' ? units : BigInt(Math.max(0, Math.floor(units)));
    if (amount <= 0n) return;

    if (this.fuelRemaining < amount) {
      this.fuelConsumed += this.fuelRemaining;
      this.fuelRemaining = 0n;
      throw new WasmFuelExhaustedError(this.initialFuel, this.fuelConsumed, this.pluginId);
    }

    this.fuelRemaining -= amount;
    this.fuelConsumed += amount;
  }

  public reset(): void {
    this.fuelRemaining = this.initialFuel;
    this.fuelConsumed = 0n;
  }

  public createHostImports(): Record<string, Function> {
    return {
      consume_fuel: (units: number): void => {
        this.consume(units);
      },
      host_consume_fuel: (units: number): void => {
        this.consume(units);
      },
      get_fuel_remaining: (): number => {
        return Number(this.fuelRemaining);
      },
    };
  }
}
