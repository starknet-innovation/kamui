# Kamui Sepolia Beta — Privacy Notice

> **DRAFT — NOT FOR PUBLICATION.** Prepared from the code in this repository on 13 November 2026. It needs legal and privacy review before it is published or linked from the Google OAuth consent screen. Text in `[square brackets]` must be completed by legal. Each factual statement should be checked against the running deployment.

_Last updated: [date]_

## 1. Who we are

Kamui is a test wallet that lets you sign in with a Google account and control a Starknet account on the **Starknet Sepolia test network**. The beta is operated by **[legal entity name, registered address]** ("we", "us").

Contact for privacy questions and requests: **[privacy contact email]**.

[Legal: confirm the controller and whether a representative or DPO must be named.]

## 2. What this beta is

The beta runs only on Starknet Sepolia, a public **test** network. Test tokens have no monetary value. Do not use the beta for anything of real value.

## 3. Information we process

### 3.1 Google sign-in

When you sign in, Google sends your browser a signed identity token. We request only the `openid` scope; we do **not** request your email address, name or profile picture, and we do not use or store them.

We use these fields from the token: issuer (`iss`), our app's client ID (`aud`), your Google account identifier (`sub`), a one-time `nonce`, and the token's issue and expiry times.

The token is sent from your browser to our pepper service and, when an account is first created, to our backend. We check it and then discard it. We do not store the raw token.

### 3.2 Pepper and account identity

Our pepper service computes a secret value (the "pepper") from your Google issuer and account identifier using a key held in AWS Key Management Service. The pepper is returned to your browser and is not stored by the service.

Your account's identity value is a one-way hash of your Google issuer, our app's client ID, your Google account identifier and your pepper. Without the pepper key, this hash cannot be linked back to your Google account. **We hold that key, so we are technically able to recompute which Starknet account belongs to a given Google account identifier.**

### 3.3 Information published on the blockchain

Starknet is a public blockchain. When your account is created, the identity hash described above and our app's client ID are written to the network. Your account address, your transactions, device keys added or removed, recovery events, session revocations and spending policies are also public.

**Information written to the blockchain is public and permanent. We cannot change or delete it.**

Your Google account identifier, pepper and identity token are not published. During recovery they are used only inside a proof generated in your browser.

### 3.4 Information stored on our servers

| Data | Why | How long |
|---|---|---|
| Connected-app sessions: your account address, a session public key, the website origin and app name you connected to, permitted contracts and functions, spending limits, and timestamps | To let apps you approve act within the limits you set | Until the session expires or you revoke it; expired sessions are removed hourly |
| Recovery and deployment jobs: account address, identity hash, transaction details, and a one-way fingerprint derived from the request | To complete account creation or recovery safely | Deleted 30 minutes after the job finishes |
| Sponsored-fee records: account address, app, fee amount and time | To account for transaction fees we sponsor and enforce limits | [Currently kept without a deletion schedule — legal to set retention] |
| Database backups | To restore service after a failure | [Proposed: 7 days of full backups — legal to confirm] |

### 3.5 IP addresses and logs

Your IP address is used briefly in memory to rate-limit requests and prevent abuse. It is not written to our databases, and our web server does not keep access logs.

Our application logs record technical events such as request outcomes, timings, account addresses and transaction hashes. They are designed to exclude identity tokens, Google account identifiers, email addresses, IP addresses and website origins. Logs are limited in size and overwritten as new entries arrive.

[Legal: decide whether a time-based log retention period must be stated.]

### 3.6 Information stored in your browser

The wallet stores data in your browser's IndexedDB, encrypted with a key that cannot be exported from the browser: your device's private key, your account details and your pepper. A temporary sign-in state is held in session storage during sign-in.

You can download a recovery file containing your account address, network details, the issuer and client ID, and your pepper. It does not contain your Google account identifier. Keep it private.

We do not use cookies, analytics or advertising trackers.

## 4. Why we process it

- To create and recover your test account and let you sign transactions — [legal basis: legal to complete].
- To let apps you approve use your account within your limits — [legal basis].
- To sponsor test transaction fees and enforce spending limits — [legal basis].
- To keep the service secure and prevent abuse — [legal basis, e.g. legitimate interests].

## 5. Who we share it with

- **Google**, to sign you in. Google will know that you signed in to Kamui. Google's own privacy policy applies.
- **Amazon Web Services (Ireland, eu-west-1)** hosts our servers, database backups and the pepper key.
- **Starknet RPC nodes.** Our servers and **your browser** read the Starknet network through **[operator of `sepolia.nodes.starknet.org` — legal to confirm the entity]**. When that node cannot answer (for example it is down or rate-limited), the request is sent instead to **ZAN**'s public endpoint. Whichever node answers can see your IP address and the account and contract data requested. The node applies per-IP rate limits. [Legal: confirm whether the node operator's logging or retention needs to be described.]
- **AVNU** [only if the paymaster is enabled for the beta — confirm] may receive your account address, transaction calls and signature to sponsor fees.
- **Cloudflare** provides our DNS. It does not see your traffic to our servers.
- **The certificate authority** that issues our TLS certificates. It receives no information about you.
- **Anyone on the public blockchain**, as described in section 3.3.

[Legal: international transfer mechanisms, if any of these providers process data outside the UK/EEA; disclosure to authorities.]

## 6. Your rights

[Legal: list the applicable rights, e.g. access, correction, deletion, restriction, objection and complaint to a supervisory authority, and how to exercise them.]

Note that we cannot delete or change information already written to the public blockchain. You can revoke app sessions at any time from the wallet.

## 7. Children

The beta is not intended for anyone under [age]. [Legal to confirm.]

## 8. Changes

We may update this notice. We will change the "Last updated" date and, for significant changes, [how users will be told].

## 9. Contact

[Privacy contact email] · [postal address]
