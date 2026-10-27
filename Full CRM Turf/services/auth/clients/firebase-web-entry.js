// The website's Firebase sign-in, bundled with the SDK into services/core-api/website/firebase-auth.js, so its
// scripts come from the website itself (only Google's sign-in script comes from Google). Rebuild: node tools/firebase/build-website.mjs
import { initializeApp } from "firebase/app";
import { applyActionCode, createUserWithEmailAndPassword, getAuth, getMultiFactorResolver, getRedirectResult, GoogleAuthProvider, multiFactor, OAuthProvider, sendEmailVerification, signInWithEmailAndPassword, signInWithRedirect, signOut, TotpMultiFactorGenerator, updateProfile } from "firebase/auth";

export { AuthError, createFirebaseAuth } from "./firebase-auth-client.js";

/** The SDK functions createFirebaseAuth takes, for a project's web config (apiKey, authDomain, projectId, appId). */
export function firebaseSdk(config) {
  return { applyActionCode, createUserWithEmailAndPassword, getMultiFactorResolver, getRedirectResult, GoogleAuthProvider, multiFactor, OAuthProvider, sendEmailVerification, signInWithEmailAndPassword, signInWithRedirect, signOut, TotpMultiFactorGenerator, updateProfile, auth: getAuth(initializeApp(config)) };
}
