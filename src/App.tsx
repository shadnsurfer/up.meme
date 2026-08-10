import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RootLayout } from './components/SearchPalette';
import { Shell } from './components/Shell';
import { Landing } from './pages/Landing';
import { Explore } from './pages/Explore';
import { Launch } from './pages/Launch';
import { Fees } from './pages/Fees';
import { NotFound } from './pages/NotFound';

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <Landing /> },
      {
        element: <Shell />,
        children: [
          { path: '/explore', element: <Explore /> },
          { path: '/launch', element: <Launch /> },
          { path: '/fees', element: <Fees /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
