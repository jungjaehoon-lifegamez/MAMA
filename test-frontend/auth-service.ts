/**
 * Authentication Service
 * Handles user authentication operations
 */

interface LoginRequest {
  email: string;
  password: string;
}

interface AuthResponse {
  userId: string;
  token: string;
  email: string;
}

class AuthService {
  private baseUrl: string = '/api/auth';

  /**
   * Login user with credentials
   */
  async login(credentials: LoginRequest): Promise<AuthResponse> {
    const response = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });

    if (response.status === 400) {
      throw new Error('Missing credentials');
    }

    if (response.status === 401) {
      throw new Error('Invalid credentials');
    }

    if (!response.ok) {
      throw new Error('Login failed');
    }

    const result: AuthResponse = await response.json();

    // Store token for future requests
    this.storeToken(result.token);

    return result;
  }

  /**
   * Store authentication token
   */
  private storeToken(token: string): void {
    localStorage.setItem('authToken', token);
  }

  /**
   * Get stored authentication token
   */
  getToken(): string | null {
    return localStorage.getItem('authToken');
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.getToken() !== null;
  }
}

export default AuthService;
