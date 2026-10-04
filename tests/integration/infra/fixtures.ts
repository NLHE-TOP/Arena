/**
 * Deterministic loopback fixtures shared by every integration command.
 *
 * The API key must never be a substring of the model (or any other fixture
 * string): the product sanitizer redacts exact configured secret values
 * everywhere, by design. Overlapping fixtures would make canonical requests
 * legitimately un-inspectable.
 */
export const FIXTURE_MODEL = 'nlhe-it-fake-model';
export const FIXTURE_API_KEY = 'it-secret-4f1c9a';
