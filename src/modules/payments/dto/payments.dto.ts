import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiDateTimeProperty, ApiObjectIdProperty } from '@/common/swagger';

const PRICE_ID = /^price_[A-Za-z0-9]{6,255}$/;

export class CheckoutDto {
  @ApiProperty({ example: 'price_1Q0abcDEF' })
  @Matches(PRICE_ID, { message: 'Choose a plan or product from the list.' })
  priceId: string;

  @ApiProperty({ enum: ['payment', 'subscription'], example: 'subscription' })
  @IsIn(['payment', 'subscription'])
  mode: 'payment' | 'subscription';

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;
}

export class PaymentIntentDto {
  @ApiProperty({ example: 'price_1Q0abcDEF', description: 'A one-time price; its amount is charged' })
  @Matches(PRICE_ID, { message: 'Choose a plan or product from the list.' })
  priceId: string;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Pro plan' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Everything in Free, plus more' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 999, description: 'Price in the minor unit (cents)' })
  @IsInt()
  @Min(50)
  @Max(99_999_999)
  unitAmount: number;

  @ApiProperty({ example: 'usd', description: 'ISO 4217, lower case' })
  @Matches(/^[a-z]{3}$/, { message: 'Currency must be a three-letter code such as usd.' })
  currency: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month', 'year'], description: 'Set for a subscription price' })
  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  interval?: 'day' | 'week' | 'month' | 'year';
}

class RecurringResponse {
  @ApiProperty({ type: String, enum: ['day', 'week', 'month', 'year'] })
  interval: string;

  @ApiProperty({ type: Number })
  intervalCount: number;
}

export class PriceResponse {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String })
  productId: string;

  @ApiProperty({ type: String, example: 'Pro plan' })
  productName: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ type: Number, example: 999 })
  unitAmount: number;

  @ApiProperty({ type: String, example: 'usd' })
  currency: string;

  @ApiProperty({ type: () => RecurringResponse, nullable: true })
  recurring: RecurringResponse | null;
}

export class CheckoutResponse {
  @ApiProperty({ type: String, description: 'Open this URL to pay' })
  url: string;

  @ApiProperty({ type: String })
  sessionId: string;
}

export class PaymentIntentResponse {
  @ApiProperty({ type: String })
  paymentIntentId: string;

  @ApiProperty({ type: String, description: 'For the client-side payment form' })
  clientSecret: string;
}

export class PortalResponse {
  @ApiProperty({ type: String })
  url: string;
}

export class PaymentResponse {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String, enum: ['checkout', 'payment_intent'] })
  kind: string;

  @ApiProperty({ type: String })
  priceId: string;

  @ApiProperty({ type: Number, nullable: true })
  amount: number | null;

  @ApiProperty({ type: String, nullable: true })
  currency: string | null;

  @ApiProperty({ type: String, enum: ['pending', 'paid', 'failed', 'expired'] })
  status: string;

  @ApiDateTimeProperty()
  createdAt: string;
}

export class SubscriptionResponse {
  @ApiProperty({ type: String, example: 'active' })
  status: string;

  @ApiProperty({ type: String, nullable: true })
  priceId: string | null;

  @ApiDateTimeProperty({ nullable: true })
  currentPeriodEnd: string | null;

  @ApiProperty({ type: Boolean })
  cancelAtPeriodEnd: boolean;
}

export class BillingOverviewResponse {
  @ApiProperty({ type: () => [PaymentResponse] })
  payments: PaymentResponse[];

  @ApiProperty({ type: () => SubscriptionResponse, nullable: true })
  subscription: SubscriptionResponse | null;
}

export class WebhookAckResponse {
  @ApiProperty({ type: Boolean })
  received: boolean;

  @ApiProperty({ type: Boolean, description: 'True when this event id was already received (Stripe retried)' })
  duplicate: boolean;
}
