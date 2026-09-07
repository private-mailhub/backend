export interface JwtPayload {
  sub: string; // userId
  username: string;
  iat?: number;
  exp?: number;
}
