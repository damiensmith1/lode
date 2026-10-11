import Link from "next/link";

import { ProductCard } from "@/components/card";
import { paths } from "@/lib/paths";

export default function HomePage() {
  return (
    <>
      <ProductCard id="1" />
      <Link href={paths.product.getHref("2")}>second</Link>
    </>
  );
}
