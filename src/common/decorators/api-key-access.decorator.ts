import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '../../auth/api-key.service';

export const API_KEY_SCOPE_KEY = 'apiKeyScope';
export const ApiKeyAccess = (scope: ApiKeyScope) => SetMetadata(API_KEY_SCOPE_KEY, scope);
