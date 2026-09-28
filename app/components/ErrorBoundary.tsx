import { Component, type ReactNode } from 'react';
import { Text, View } from 'react-native';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <View className="flex-1 items-center justify-center gap-3 bg-white px-6 dark:bg-black">
          <Text className="text-center text-base font-semibold text-red-600">
            Something went wrong
          </Text>
          <Text className="text-center text-sm text-neutral-500">{this.state.error.message}</Text>
          <Text className="text-sm font-medium text-blue-600" onPress={this.reset}>
            Try again
          </Text>
        </View>
      );
    }

    return this.props.children;
  }
}
