export function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}
