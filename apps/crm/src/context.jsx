import { createContext, useContext } from "react";
export const CrmContext = createContext(null);
export function useCrm() {
  return useContext(CrmContext);
}
