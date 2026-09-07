import { IsEnum, IsNotEmpty } from 'class-validator';
import { OAuthProvider } from '../../common/enums/oauth-provider.enum';

export class UnlinkOAuthDto {
  @IsNotEmpty()
  @IsEnum(OAuthProvider)
  provider: OAuthProvider;
}
