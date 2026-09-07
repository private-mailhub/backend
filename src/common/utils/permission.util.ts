import { SubscriptionTier } from '../enums/subscription-tier.enum';
import { User } from 'src/users/entities/user.entity';
import { UserRole } from 'src/users/user.enums';

/**
 * Check pro subcription tier
 * @param user
 * @returns
 */
export function isProTier(user: User): boolean {
  return user.subscriptionTier === SubscriptionTier.PRO || user.role === UserRole.ADMIN;
}

/**
 * Check admin role
 * @param role
 * @returns
 */
export function isAdmin(role: UserRole): boolean {
  return role === UserRole.ADMIN;
}
