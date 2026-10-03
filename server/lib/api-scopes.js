'use strict';

/*
 * The scopes a ScreenTinker API token can carry. ONE definition: it is minted against in
 * routes/tokens.js and published in the protected-resource metadata, and a document that advertises
 * a scope the minting code rejects is worse than one that says nothing.
 */
const SCOPES = Object.freeze(['read', 'write', 'full', 'agency', 'billing:read']);

module.exports = { SCOPES };
