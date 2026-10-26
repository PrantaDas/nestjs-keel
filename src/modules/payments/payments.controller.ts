import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, Public, RequirePermissions } from '@/common/auth/auth.decorators';
import { Permission } from '@/common/auth/permissions';
import { Audit } from '@/common/decorators/audit.decorator';
import { ResponseMessage, SkipEnvelope } from '@/common/decorators/response.decorators';
import { SystemErrors } from '@/common/exceptions';
import { ApiEnvelope, ApiEnvelopeArray, ApiStandardErrors } from '@/common/swagger';
import { IntegrationErrors } from '@/integrations/resilience/failure';
import { StripeWebhookVerifier } from '@/integrations/stripe/stripe-webhook.verifier';
import {
  BillingOverviewResponse,
  CheckoutDto,
  CheckoutResponse,
  CreateProductDto,
  PaymentIntentDto,
  PaymentIntentResponse,
  PortalResponse,
  PriceResponse,
} from './dto/payments.dto';
import { PaymentsErrors } from './payments.errors';
import { PaymentsService } from './payments.service';
import { StripeEventsService } from './stripe-events.service';

const PROVIDER_ERRORS = [
  SystemErrors.INTEGRATION_NOT_CONFIGURED,
  SystemErrors.INTEGRATION_FAILED,
  IntegrationErrors.INTEGRATION_UNAVAILABLE,
] as const;

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('prices')
  @ApiOperation({ summary: 'Plans and products for sale', operationId: 'paymentsPrices' })
  @ApiEnvelopeArray(PriceResponse)
  @ApiStandardErrors(...PROVIDER_ERRORS)
  @ResponseMessage('Plans loaded.')
  prices() {
    return this.payments.prices();
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Start a hosted checkout (one-time or subscription)', operationId: 'paymentsCheckout' })
  @ApiEnvelope(CheckoutResponse)
  @ApiStandardErrors(PaymentsErrors.PRICE_NOT_FOUND, PaymentsErrors.WRONG_PRICE_TYPE, ...PROVIDER_ERRORS)
  @ResponseMessage('Checkout ready.')
  checkout(@CurrentUser('id') userId: string, @Body() dto: CheckoutDto) {
    return this.payments.checkout(userId, dto);
  }

  @Post('payment-intents')
  @ApiOperation({ summary: 'Start an in-app payment for a one-time price', operationId: 'paymentsIntentCreate' })
  @ApiEnvelope(PaymentIntentResponse)
  @ApiStandardErrors(PaymentsErrors.PRICE_NOT_FOUND, PaymentsErrors.WRONG_PRICE_TYPE, ...PROVIDER_ERRORS)
  @ResponseMessage('Payment ready.')
  paymentIntent(@CurrentUser('id') userId: string, @Body() dto: PaymentIntentDto) {
    return this.payments.paymentIntent(userId, dto.priceId);
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open the billing portal (invoices, cards, cancel)', operationId: 'paymentsPortal' })
  @ApiEnvelope(PortalResponse)
  @ApiStandardErrors(PaymentsErrors.NO_BILLING_ACCOUNT, ...PROVIDER_ERRORS)
  @ResponseMessage('Billing portal ready.')
  portal(@CurrentUser('id') userId: string) {
    return this.payments.portal(userId);
  }

  @Get('me')
  @ApiOperation({ summary: 'My payments and subscription', operationId: 'paymentsMe' })
  @ApiEnvelope(BillingOverviewResponse)
  @ResponseMessage('Billing loaded.')
  me(@CurrentUser('id') userId: string) {
    return this.payments.overview(userId);
  }
}

@ApiTags('Admin · Payments')
@ApiBearerAuth()
@RequirePermissions(Permission.PAYMENTS_MANAGE)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('products')
  @Audit({ action: 'payments.product.create', resource: 'product' })
  @ApiOperation({ summary: 'Create a product with one price', operationId: 'adminPaymentsProductCreate' })
  @ApiEnvelope(PriceResponse)
  @ApiStandardErrors(...PROVIDER_ERRORS)
  @ResponseMessage('Product created.')
  create(@Body() dto: CreateProductDto) {
    return this.payments.createProduct(dto);
  }
}

/**
 * `POST /api/webhooks/stripe` (version-neutral: Stripe's endpoint URL never changes with API
 * versions). Public, but trusted only after the signature over the raw body checks out
 * (`http-app.ts` keeps the raw bytes for this path). Answers fast: the event is recorded and queued,
 * the worker applies it. Not in the API docs: only Stripe calls it.
 */
@SkipThrottle()
@Controller({ path: 'webhooks/stripe', version: VERSION_NEUTRAL })
export class StripeWebhookController {
  constructor(
    private readonly verifier: StripeWebhookVerifier,
    private readonly events: StripeEventsService,
  ) {}

  @Post()
  @Public()
  @SkipEnvelope()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(@Req() req: Request, @Headers('stripe-signature') signature: string | undefined) {
    const event = this.verifier.verify(req.body, signature);
    const fresh = await this.events.receive(event);
    return { received: true, duplicate: !fresh };
  }
}
