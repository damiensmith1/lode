import Link from "next/link";

export function ProductCard({ id }: { id: string }) {
  return <Link href={`/products/${id}`}>{id}</Link>;
}
