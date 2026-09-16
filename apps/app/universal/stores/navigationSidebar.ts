/** Desktop visibility for the permanent left navigation column.
 *
 * Phone visibility remains owned by react-navigation's drawer state. On wide
 * layouts we vary the permanent drawer width instead, so closing the sidebar
 * expands the workspace instead of translating and clipping it off-screen.
 */

import { create } from 'zustand';

interface NavigationSidebarState {
  isOpen: boolean;
  toggle: () => void;
}

export const useNavigationSidebar = create<NavigationSidebarState>((set) => ({
  isOpen: true,
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
