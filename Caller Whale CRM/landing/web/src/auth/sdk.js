// The Firebase SDK functions the shared sign-in client takes (firebase-auth-client.js, a copy kept in step by
// services/auth/clients/sync.mjs). Loaded only when someone signs in or is signed in, so the other pages stay light.
import { initializeApp } from "firebase/app";
import {
  applyActionCode, createUserWithEmailAndPassword, getAuth, getMultiFactorResolver, getRedirectResult, GoogleAuthProvider, multiFactor,
  OAuthProvider, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithRedirect, signOut,
  TotpMultiFactorGenerator, updateProfile,
} from "firebase/auth";

export { AuthError, createFirebaseAuth } from "./firebase-auth-client.js";

/** The SDK for a project's web config (apiKey, authDomain, projectId, appId). */
export function firebaseSdk(config) {
  const auth = getAuth(initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId }));
  return {
    applyActionCode, createUserWithEmailAndPassword, getMultiFactorResolver, getRedirectResult, GoogleAuthProvider, multiFactor, OAuthProvider,
    sendEmailVerification, signInWithEmailAndPassword, signInWithRedirect, signOut, TotpMultiFactorGenerator, updateProfile, auth,
    resetPassword: email => sendPasswordResetEmail(auth, email),
  };
}
