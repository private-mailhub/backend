import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CustomEnvService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Get a required environment variable as generics
   * @throws Error if the variable is not defined
   */
  get<T>(key: string): T {
    const value = this.configService.get<T>(key);
    if (value === undefined || value === null) {
      throw new Error(`Environment variable ${key} is not defined`);
    }
    return value;
  }

  /**
   * Get a required environment variable as generics with default value
   */
  getWithDefault<T>(key: string, def: T): T {
    const value = this.configService.get<T>(key);
    if (value === undefined || value === null) {
      return def;
    }
    return value;
  }
}
