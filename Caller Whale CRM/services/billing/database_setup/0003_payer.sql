-- Who pays for a workspace's subscription (build step 13): the person whose payment method the provider holds, as the checkout tells
-- the provider (custom_data.payer_id). A handover of ownership completes only once the new owner pays (D70).
ALTER TABLE billing.subscriptions ADD COLUMN payer_id uuid;
