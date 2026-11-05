export function phoneNumberKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 && !String(value).trim().startsWith("+") ? "1" + digits : digits;
}

export function validPhoneNumber(value) {
  const number = String(value || "").trim();
  const digits = number.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 && /^\+?[\d ()-]+$/.test(number);
}
