import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  useRef,
  useLayoutEffect,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import { cn } from "@/lib/utils";

type BtnVariant = "primary" | "soft" | "ghost" | "outline" | "danger";
const btnStyles: Record<BtnVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
  soft: "bg-primary-soft text-accent-foreground hover:bg-primary-soft/70",
  ghost: "text-foreground hover:bg-muted",
  outline: "border border-input bg-card text-foreground hover:bg-muted",
  danger: "bg-destructive/10 text-destructive-strong hover:bg-destructive/15",
};

export function Btn({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition-all active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        size === "sm" && "min-h-11 min-w-11 px-3 text-sm",
        size === "md" && "h-11 px-4 text-sm",
        size === "lg" && "h-13 px-5 text-base",
        btnStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card-surface", className)} {...props}>
      {children}
    </div>
  );
}

export function Field({
  label,
  suffix,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  suffix?: string | undefined;
  error?: string | undefined;
}) {
  const generatedId = useId();
  const {
    id: inputId,
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    ...inputProps
  } = props;
  const id = inputId ?? generatedId;
  const errorId = `${id}-error`;

  return (
    <label className={cn("block min-w-0", className)}>
      <span
        id={`${id}-label`}
        className="mb-1.5 block break-words text-xs font-medium text-muted-foreground"
      >
        {label}
      </span>
      <span
        className={cn(
          "flex h-12 items-center rounded-xl border bg-card px-3.5 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15",
          error ? "border-destructive" : "border-input",
        )}
      >
        <input
          id={id}
          aria-labelledby={`${id}-label`}
          className="tabular w-full min-w-0 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/60"
          aria-invalid={error ? true : invalid}
          aria-describedby={error ? errorId : describedBy}
          {...inputProps}
        />
        {suffix && <span className="ml-2 text-sm text-muted-foreground">{suffix}</span>}
      </span>
      {error && (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive-strong">
          {error}
        </span>
      )}
    </label>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
  }, [open]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px] animate-in fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
          className="pb-safe fixed bottom-0 left-1/2 z-50 max-h-[90dvh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-t-3xl bg-card p-5 shadow-2xl animate-in slide-in-from-bottom-8 duration-300 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-3xl"
        >
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border sm:hidden" />
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Zamknij"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary">
        {icon}
      </div>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3">
      <div>
        {subtitle && <p className="text-sm font-medium text-muted-foreground">{subtitle}</p>}
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
      </div>
      {right}
    </header>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-muted", className)} />;
}
