/*
 * What the login form shows, as a pure decision.
 *
 * Extracted because it got this wrong in a way nobody could see from reading the handlers: the
 * state lived in two mutable flags updated from four event listeners, and one of those listeners
 * undid first-run setup on the first keystroke.
 *
 * THE BUG. On a fresh install with no users, the page set identified = true so both fields were
 * available, because there is nobody to identify - the operator is creating the first account.
 * Then typing in the email box fired the "editing the address returns to the identifier step"
 * listener, which set identified = false and re-applied the state, hiding the password field
 * mid-typing and relabelling the button "Next".
 *
 * Identifier-first exists to ask the server which identity provider an EXISTING address uses, so
 * an SSO-only user is never shown a password box that will be refused. With an empty user table
 * there is no such question, so the whole two-step flow has to be inert - not merely initialised
 * to a state that a later event can undo.
 */

/**
 * @param {{isSetup: boolean, identified: boolean, ssoOnlyDomain: boolean}} state
 * @returns {{showPassword: boolean, showButton: boolean, buttonKey: string}}
 */
export function loginFormState({ isSetup, identified, ssoOnlyDomain }) {
  // First-run setup: every field is needed at once and no event may take one away. Deliberately
  // ignores `identified` and `ssoOnlyDomain` rather than trusting them to hold the right values -
  // that trust is what broke.
  if (isSetup) {
    return { showPassword: true, showButton: true, buttonKey: 'auth.create_admin_account' };
  }

  const known = identified && !ssoOnlyDomain;
  return {
    showPassword: known,
    // An SSO-only domain has nothing to press: the provider button is the only way in.
    showButton: !ssoOnlyDomain,
    buttonKey: known ? 'auth.sign_in' : 'auth.next',
  };
}
