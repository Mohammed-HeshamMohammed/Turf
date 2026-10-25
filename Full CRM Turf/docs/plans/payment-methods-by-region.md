# Payment methods by region

**Status:** Draft (2026-10-25). Part of [Feature 9: Accounts, security and billing](../features/09-accounts-security-billing.md).

How customers in each region can pay for Turf, through which provider, what it costs, and who owes the tax on the sale.

## Who pays for Turf

Turf is built for calling **US** property owners, but the people paying are not all in the US:

- **US investors and teams**: most customers.
- **Canadian and European investors** buying US property.
- **Calling teams abroad** working US leads for US clients: call centers in Egypt and elsewhere in Africa, Latin America and Asia.

So every region below needs a way to pay, even though the leads are all American.

## The rules

1. **Paddle is the default checkout everywhere.** As merchant of record, Paddle is the seller and handles the tax in every region: US sales tax, EU VAT, Canadian GST/HST, and digital VAT in other countries. Turf files none of it.
2. **Stripe is used only where it saves real money**, mainly US bank debit for big annual plans. Every Stripe sale is Turf's own sale, so Turf owes the tax on it; keeping Stripe mostly to the US keeps Turf out of foreign tax registrations.
3. **Prices are in US dollars.** Paddle can show local currencies at checkout.
4. **No crypto.** Egypt's Central Bank law (No. 194 of 2020) bars trading and promoting crypto without a licence, and that applies to the founder living in Egypt whatever country the company is in.
5. **Stripe and US bank debit need the US company.** Stripe is not open to businesses registered in Egypt. Paddle and Stripe pay out to the US company's account (see [Company setup](../features/09-accounts-security-billing.md#company-setup)).

## By region

### United States

| Method | Provider | Fee | Tax handled by |
| --- | --- | --- | --- |
| Cards (Visa, Mastercard, Amex, Discover) | Paddle | 5% + $0.50 | Paddle |
| Apple Pay, Google Pay | Paddle | 5% + $0.50 | Paddle |
| PayPal | Paddle | 5% + $0.50 | Paddle |
| **Bank debit (ACH)** for annual plans and big teams | Stripe | **0.8%, capped at $5**; $4 per failed debit; $15 per dispute | **Turf** (Stripe Tax +0.5% tracks it) |
| Wire transfer for large invoices | Stripe or manual invoice | ~$8 per incoming wire (Stripe) / bank fees | **Turf** |

US sales tax on Turf's own (Stripe and manual) sales: software is taxable in about 26 states, and a state's duty starts once Turf's direct sales there pass its threshold (usually $100,000 a year; $500,000 in California, Texas and New York).

### Canada

| Method | Provider | Fee | Tax handled by |
| --- | --- | --- | --- |
| Cards | Paddle | 5% + $0.50 | Paddle |
| Apple Pay, Google Pay, PayPal | Paddle | 5% + $0.50 | Paddle |
| Bank debit (pre-authorized debit) for big annual plans | Stripe | Check Stripe's current rate | **Turf** |

Canadian GST/HST: a non-resident selling digital services must register once sales to Canadian customers pass **CAD 30,000 in 12 months**; sales through a platform that already collects the tax (Paddle) don't count. Keeping Canadian customers on Paddle avoids registering.

### Latin America and the rest of the Americas

| Method | Provider | Fee | Tax handled by |
| --- | --- | --- | --- |
| Cards (international) | Paddle | 5% + $0.50 | Paddle |
| PayPal | Paddle | 5% + $0.50 | Paddle |
| Local methods: Pix and boleto (Brazil), OXXO and SPEI (Mexico) | Stripe offers them in its own markets; whether a US Stripe account can take them from these countries must be checked | — | Turf |

Start with cards and PayPal through Paddle. Add local methods only if Latin American calling teams ask for them.

### Europe (EU, UK and the rest)

| Method | Provider | Fee | Tax handled by |
| --- | --- | --- | --- |
| Cards | Paddle | 5% + $0.50 | Paddle |
| Apple Pay, Google Pay, PayPal | Paddle | 5% + $0.50 | Paddle |
| iDEAL / Wero (Netherlands, EUR) | Paddle | 5% + $0.50 | Paddle |
| Bancontact (Belgium, EUR) | Paddle | 5% + $0.50 | Paddle |
| BLIK (Poland) | Paddle | 5% + $0.50 | Paddle |
| Bank transfer (subscriptions in EUR, GBP or USD) | Paddle | 5% + $0.50 | Paddle |
| SEPA Direct Debit | Stripe | Check Stripe's current rate | **Turf** |

EU VAT: a seller from outside the EU owes VAT on digital services **from the first euro**, registered through the EU's non-Union One-Stop Shop. **Keep European customers on Paddle**: it is the seller, so Turf registers for nothing. Don't sell to Europe through Stripe.

### Africa (including Egypt)

| Method | Provider | Fee | Tax handled by |
| --- | --- | --- | --- |
| Cards in USD | Paddle | 5% + $0.50 | Paddle |
| PayPal | Paddle | 5% + $0.50 | Paddle |
| Mobile money (M-Pesa in Kenya, MTN MoMo and others) and local cards | Paystack or Flutterwave, **later** | M-Pesa ~1.5%; local cards ~1.4–2.9%; international cards ~3.8–4.8% | **Turf** (they are not merchants of record) |
| Egyptian local methods (Fawry, InstaPay, Egyptian cards in EGP) | Egyptian gateways such as Paymob, **only through an Egyptian company** | — | Turf's Egyptian company |

Many African banks block or limit international USD card payments, so some African teams will struggle at a card checkout. Start with Paddle (cards and PayPal); add Paystack or Flutterwave only when enough African customers ask, and get local tax advice first, since they leave the tax with Turf.

## Summary

| Region | Start with | Add later |
| --- | --- | --- |
| **United States** | Paddle (cards, wallets, PayPal) + Stripe ACH for annual plans | Wire / manual invoices for big deals |
| **Canada** | Paddle | Stripe pre-authorized debit for big annual plans |
| **Latin America** | Paddle (cards, PayPal) | Local methods if asked for |
| **Europe** | Paddle (cards, wallets, PayPal, iDEAL, Bancontact, BLIK, bank transfer) | Nothing: stay on Paddle for VAT |
| **Africa** | Paddle (cards, PayPal) | Paystack / Flutterwave mobile money; Egyptian methods through an Egyptian company |

## Check before launch

- [ ] Paddle accepts Turf (a US LLC run from Egypt) as a seller, and its current payment methods per country.
- [ ] Stripe accepts the US LLC; whether it can take Canadian pre-authorized debit, SEPA Direct Debit and Latin American methods, and their current fees.
- [ ] The bank (Mercury or Wise) accepts owners living in Egypt.
- [ ] A US accountant on US sales tax and the LLC's filings; an Egyptian tax adviser on Egyptian tax.

Sources: [Paddle payment methods](https://developer.paddle.com/concepts/payment-methods/overview) · [Paddle: which payment methods do you support](https://paddle.com/help/start/intro-to-paddle/which-payment-methods-do-you-support) · [Paddle payment methods (docs index)](https://developer.paddle.com/concepts/payment-methods.md) · [Stripe international fees 2026 (Checkout Page)](https://checkoutpage.com/blog/stripe-international-fees) · [Stripe ACH fees (Dodo Payments)](https://dodopayments.com/blogs/stripe-ach-fees/) · [Stripe fees explained 2026](https://transferfees.io/guides/stripe-fees-explained/) · [Paystack vs Flutterwave M-Pesa fees 2026 (Kolonell)](https://kolonell.com/en/blog/paystack-flutterwave-mpesa-transaction-fees-comparison-2026) · [Flutterwave alternatives for African SaaS (Dodo Payments)](https://dodopayments.com/blogs/flutterwave-alternatives) · [Paystack alternatives for African SaaS (Dodo Payments)](https://dodopayments.com/blogs/paystack-alternatives) · [Canada and EU tax changes (Sales Tax Institute)](https://www.salestaxinstitute.com/resources/sales-tax-changes-canada-eu) · [VAT and GST thresholds for digital sellers (Dodo Payments)](https://dodopayments.com/blogs/vat-gst-registration-thresholds/) · [Stripe: registering for tax outside the US](https://docs.stripe.com/tax/use-stripe-to-register/outside-united-states) · [SaaS sales tax statistics (Anrok)](https://www.anrok.com/resources/sales-tax-statistics) · [Economic nexus by state (Taxually)](https://www.taxually.com/blog/economic-nexus-by-state) · [Legality of cryptocurrency in Egypt (Andersen)](https://eg.andersen.com/legality-cryptocurrency-in-egypt/)
