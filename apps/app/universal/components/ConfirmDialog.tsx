import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View, Platform } from 'react-native';
import { colors, font, radius, glassSurface } from '../theme';
import Button, { type ButtonVariant } from './Button';

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Visual weight of the confirm button. Use ``'danger'`` for destructive
   *  actions (delete) — renders red on web and as an iOS ``destructive``
   *  button on native. Defaults to ``'primary'``. */
  confirmVariant?: ButtonVariant;
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const close = useCallback((value: boolean) => {
    setRequest((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const confirm = useCallback<ConfirmFn>((options) => {
    const normalized = typeof options === 'string' ? { message: options } : options;

    if (Platform.OS !== 'web') {
      return new Promise((resolve) => {
        Alert.alert(
          normalized.title ?? 'Confirm',
          normalized.message,
          [
            {
              text: normalized.cancelLabel ?? 'Cancel',
              style: 'cancel',
              onPress: () => resolve(false),
            },
            {
              text: normalized.confirmLabel ?? 'Confirm',
              style: normalized.confirmVariant === 'danger' ? 'destructive' : 'default',
              onPress: () => resolve(true),
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
    }

    return new Promise((resolve) => {
      setRequest({
        title: normalized.title ?? 'Confirm',
        message: normalized.message,
        confirmLabel: normalized.confirmLabel ?? 'Confirm',
        cancelLabel: normalized.cancelLabel ?? 'Cancel',
        confirmVariant: normalized.confirmVariant ?? 'primary',
        resolve,
      });
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        animationType="fade"
        transparent
        visible={!!request}
        onRequestClose={() => close(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => close(false)}
            {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
          />
          <View
            style={styles.dialog}
            // @ts-ignore
            {...(Platform.OS === 'web' ? { className: 'oa-slide-up' } : {})}
          >
            <Text style={styles.title}>{request?.title}</Text>
            <Text style={styles.message}>{request?.message}</Text>
            <View style={styles.actions}>
              <Button
                variant="secondary"
                label={request?.cancelLabel}
                onPress={() => close(false)}
              />
              <Button
                variant={request?.confirmVariant ?? 'primary'}
                label={request?.confirmLabel}
                onPress={() => close(true)}
              />
            </View>
          </View>
        </View>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used within ConfirmProvider');
  }
  return confirm;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    // Dim the scene only — the blur lives on the dialog itself so the
    // frost is scoped to the panel, not smeared across the whole screen.
    backgroundColor: 'rgba(2, 4, 10, 0.45)',
  },
  dialog: {
    width: 400,
    maxWidth: '100%',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    // Shared frosted-glass recipe — matches the nav header exactly.
    backgroundColor: glassSurface.backgroundColor,
    // @ts-ignore — frost the panel background only.
    ...(Platform.OS === 'web' ? { backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter } : {}),
    padding: 20,
    shadowColor: 'rgba(0,0,0,0.18)',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 1,
    shadowRadius: 48,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
    fontFamily: font.display,
    letterSpacing: -0.2,
  },
  message: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 18,
  },
  cancelBtn: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  confirmBtn: {},
  confirmBtnInner: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  confirmText: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: '600',
  },
});
