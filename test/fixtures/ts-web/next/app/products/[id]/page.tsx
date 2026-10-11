import { save } from "@/app/actions";

export default async function ProductPage({ params }: { params: { id: string } }) {
  await save(params.id);
  return <p>{params.id}</p>;
}
