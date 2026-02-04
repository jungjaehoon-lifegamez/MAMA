/**
 * User Registration Form
 * Frontend component for user registration
 */

interface RegisterFormData {
  email: string;
  password: string;
  name: string;
}

class RegistrationForm {
  private formElement: HTMLFormElement;

  constructor(formId: string) {
    const element = document.getElementById(formId);
    if (!element || !(element instanceof HTMLFormElement)) {
      throw new Error(`Form element with id '${formId}' not found or not a form`);
    }
    this.formElement = element;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.formElement.addEventListener('submit', this.handleSubmit.bind(this));
  }

  private async handleSubmit(event: Event) {
    event.preventDefault();

    const formData = this.getFormData();

    try {
      // Call backend registration API
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          name: formData.name,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `Registration failed (${response.status}): ${errorBody || response.statusText}`
        );
      }

      const result = await response.json();

      // Handle successful registration
      console.log('Registration successful:', result);
      // Expected response: { userId, token, email }

      // Store token and redirect
      localStorage.setItem('authToken', result.token);
      window.location.href = '/dashboard';
    } catch (error) {
      console.error('Registration error:', error);
      alert('Registration failed. Please try again.');
    }
  }

  private getFormData(): RegisterFormData {
    const formData = new FormData(this.formElement);

    // Validate FormData results with null checks
    const email = formData.get('email');
    const password = formData.get('password');
    const name = formData.get('name');

    if (!email || !password || !name) {
      throw new Error('Missing required form fields');
    }

    if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
      throw new Error('Invalid form field types');
    }

    return {
      email,
      password,
      name,
    };
  }
}

export default RegistrationForm;
