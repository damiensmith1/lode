const Stack = { Navigator: (_: unknown) => null, Screen: (_: unknown) => null };

export function HomeScreen({ navigation }: { navigation: { navigate(name: string): void } }) {
  return <button onClick={() => navigation.navigate("Profile")} />;
}

export function ProfileScreen() {
  return <p>profile</p>;
}

export function App() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
    </Stack.Navigator>
  );
}
