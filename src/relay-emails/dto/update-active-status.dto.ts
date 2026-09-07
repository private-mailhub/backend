import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateActiveStatusDto {
  @IsNotEmpty()
  @IsBoolean()
  isActive: boolean;
}
