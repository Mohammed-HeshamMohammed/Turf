//! The signing key and the public keys every other service checks tokens with.

use base64::{engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use callerwhale_auth_verify::{Claims, Verifier, AUDIENCE, ISSUER};

/// What a token says about the person it is for.
pub struct Person {
    pub id: String,
    pub email: String,
    pub name: String,
    pub email_verified: bool,
}

pub struct Keys {
    pub kid: String,
    encoding: EncodingKey,
    /// What `/.well-known/jwks.json` serves.
    pub jwks: String,
    pub verifier: Verifier,
}

impl Keys {
    /// From base64 of an Ed25519 PKCS#8 key.
    pub fn from_base64(text: &str) -> anyhow::Result<Self> {
        Self::from_pkcs8(&STANDARD.decode(text.trim())?)
    }

    /// A new key. Tokens it signs stop working when the process ends.
    pub fn generate() -> anyhow::Result<Self> {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).map_err(|_| anyhow::anyhow!("could not make a key"))?;
        Self::from_pkcs8(pkcs8.as_ref())
    }

    /// The base64 form of a new key, for AUTH_SIGNING_KEY.
    pub fn new_secret() -> anyhow::Result<String> {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).map_err(|_| anyhow::anyhow!("could not make a key"))?;
        Ok(STANDARD.encode(pkcs8.as_ref()))
    }

    fn from_pkcs8(pkcs8: &[u8]) -> anyhow::Result<Self> {
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| anyhow::anyhow!("AUTH_SIGNING_KEY is not an Ed25519 PKCS#8 key"))?;
        let public = pair.public_key().as_ref();
        // The key id is derived from the public key, so a new key gets a new id and old tokens are refused cleanly.
        let kid = hex::encode(&Sha256::digest(public)[..8]);
        let jwks = serde_json::json!({
            "keys": [{ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": URL_SAFE_NO_PAD.encode(public) }]
        })
        .to_string();
        let verifier = Verifier::from_jwks_json(&jwks)?;
        Ok(Keys { kid, encoding: EncodingKey::from_ed_der(pkcs8), jwks, verifier })
    }

    /// A signed access token for a person and their session.
    pub fn sign(&self, person: &Person, sid: &str, mfa: bool, provider: &str, now: u64, minutes: u64) -> anyhow::Result<(String, u64)> {
        let exp = now + minutes * 60;
        let claims = Claims {
            sub: person.id.clone(),
            email: person.email.clone(),
            name: person.name.clone(),
            sid: sid.into(),
            mfa,
            email_verified: person.email_verified,
            provider: provider.into(),
            iss: ISSUER.into(),
            aud: AUDIENCE.into(),
            iat: now,
            exp,
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        Ok((encode(&header, &claims, &self.encoding)?, minutes * 60))
    }
}
